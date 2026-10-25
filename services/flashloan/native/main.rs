use revm::{
    primitives::{
        keccak256, AccountInfo, Address, Bytecode, Bytes, ExecutionResult, SpecId, TxKind, B256,
        U256,
    },
    Database, Evm,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{self, BufRead, Read, Write},
    str::FromStr,
    time::Duration,
};

#[derive(Deserialize)]
struct Request {
    version: u8,
    rpc_url: String,
    block_hash: String,
    block_number: String,
    timestamp: String,
    base_fee: String,
    gas_limit: String,
    coinbase: String,
    chain_id: u64,
    caller: String,
    executor: String,
    calldata: String,
    #[serde(default)]
    executor_code: Option<String>,
    #[serde(default)]
    executor_storage: HashMap<String, String>,
    #[serde(default)]
    caller_balance: Option<String>,
}

fn num(s: &str) -> Result<U256, String> {
    U256::from_str(s).map_err(|_| "INVALID_INTEGER".into())
}
fn addr(s: &str) -> Result<Address, String> {
    Address::from_str(s).map_err(|_| "INVALID_ADDRESS".into())
}
fn bytes(s: &str) -> Result<Bytes, String> {
    Bytes::from_str(s).map_err(|_| "INVALID_HEX".into())
}

struct Fork {
    url: String,
    block: String,
    client: reqwest::blocking::Client,
    codes: HashMap<B256, Bytecode>,
    overrides: HashMap<Address, AccountInfo>,
    storage_overrides: HashMap<(Address, U256), U256>,
    reads: usize,
}
impl Fork {
    fn rpc(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.reads += 1;
        if self.reads > 5000 {
            return Err("FORK_READ_BUDGET".into());
        }
        let response = self
            .client
            .post(&self.url)
            .json(&json!({"jsonrpc":"2.0","id":self.reads,"method":method,"params":params}))
            .send()
            .map_err(|_| "FORK_RPC_UNAVAILABLE")?;
        if !response.status().is_success() {
            return Err("FORK_RPC_REJECTED".into());
        }
        let mut body = String::new();
        response
            .take(4_000_001)
            .read_to_string(&mut body)
            .map_err(|_| "FORK_RPC_READ")?;
        if body.len() > 4_000_000 {
            return Err("FORK_RPC_BYTE_BUDGET".into());
        }
        let value: Value = serde_json::from_str(&body).map_err(|_| "FORK_RPC_JSON")?;
        if value.get("error").is_some() {
            return Err("FORK_RPC_METHOD_FAILED".into());
        }
        value
            .get("result")
            .cloned()
            .ok_or_else(|| "FORK_RPC_RESULT_MISSING".into())
    }
    fn pinned(&self) -> Value {
        json!({"blockHash":self.block,"requireCanonical":true})
    }
}
impl Database for Fork {
    type Error = String;
    fn basic(&mut self, address: Address) -> Result<Option<AccountInfo>, Self::Error> {
        if let Some(info) = self.overrides.get(&address) {
            return Ok(Some(info.clone()));
        }
        let a = format!("{address:#x}");
        let balance = self.rpc("eth_getBalance", json!([a, self.pinned()]))?;
        let nonce = self.rpc("eth_getTransactionCount", json!([a, self.pinned()]))?;
        let raw = self.rpc("eth_getCode", json!([a, self.pinned()]))?;
        let code = Bytecode::new_raw(bytes(raw.as_str().ok_or("INVALID_CODE")?)?);
        let code_hash = code.hash_slow();
        self.codes.insert(code_hash, code.clone());
        Ok(Some(AccountInfo {
            balance: num(balance.as_str().ok_or("INVALID_BALANCE")?)?,
            nonce: u64::try_from(num(nonce.as_str().ok_or("INVALID_NONCE")?)?)
                .map_err(|_| "NONCE_OVERFLOW")?,
            code_hash,
            code: Some(code),
        }))
    }
    fn code_by_hash(&mut self, code_hash: B256) -> Result<Bytecode, Self::Error> {
        self.codes
            .get(&code_hash)
            .cloned()
            .ok_or_else(|| "MISSING_CODE".into())
    }
    fn storage(&mut self, address: Address, index: U256) -> Result<U256, Self::Error> {
        if let Some(v) = self.storage_overrides.get(&(address, index)) {
            return Ok(*v);
        }
        let v = self.rpc(
            "eth_getStorageAt",
            json!([
                format!("{address:#x}"),
                format!("{index:#x}"),
                self.pinned()
            ]),
        )?;
        num(v.as_str().ok_or("INVALID_STORAGE")?)
    }
    fn block_hash(&mut self, number: u64) -> Result<B256, Self::Error> {
        let v = self.rpc(
            "eth_getBlockByNumber",
            json!([format!("0x{number:x}"), false]),
        )?;
        B256::from_str(
            v.get("hash")
                .and_then(Value::as_str)
                .ok_or("MISSING_BLOCK_HASH")?,
        )
        .map_err(|_| "INVALID_BLOCK_HASH".into())
    }
}
fn simulate(r: Request) -> Result<Value, String> {
    if r.version != 1 || ![1, 42161, 8453].contains(&r.chain_id) {
        return Err("UNSUPPORTED_ENGINE_PROTOCOL".into());
    }
    let url = reqwest::Url::parse(&r.rpc_url).map_err(|_| "INVALID_RPC_URL")?;
    if url.scheme() != "https"
        && !(url.scheme() == "http"
            && ["127.0.0.1", "localhost", "[::1]"].contains(&url.host_str().unwrap_or("")))
    {
        return Err("INSECURE_RPC_URL".into());
    }
    let caller = addr(&r.caller)?;
    let executor = addr(&r.executor)?;
    let mut db = Fork {
        url: r.rpc_url,
        block: r.block_hash,
        client: reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "HTTP_CLIENT")?,
        codes: HashMap::new(),
        overrides: HashMap::new(),
        storage_overrides: HashMap::new(),
        reads: 0,
    };
    if let Some(raw) = r.executor_code {
        let code = Bytecode::new_raw(bytes(&raw)?);
        let hash = keccak256(code.original_bytes());
        db.codes.insert(hash, code.clone());
        db.overrides.insert(
            executor,
            AccountInfo {
                code_hash: hash,
                code: Some(code),
                ..Default::default()
            },
        );
    }
    for (key, value) in r.executor_storage {
        db.storage_overrides
            .insert((executor, num(&key)?), num(&value)?);
    }
    if let Some(balance) = r.caller_balance {
        let mut info = db.basic(caller)?.unwrap_or_default();
        info.balance = num(&balance)?;
        db.overrides.insert(caller, info);
    }
    let mut evm = Evm::builder()
        .with_db(db)
        .with_spec_id(SpecId::CANCUN)
        .modify_cfg_env(|cfg| cfg.chain_id = r.chain_id)
        .modify_block_env(|b| {
            b.number = num(&r.block_number).unwrap_or_default();
            b.timestamp = num(&r.timestamp).unwrap_or_default();
            b.basefee = num(&r.base_fee).unwrap_or_default();
            b.gas_limit = num(&r.gas_limit).unwrap_or_default();
            b.coinbase = addr(&r.coinbase).unwrap_or_default();
        })
        .modify_tx_env(|tx| {
            tx.caller = caller;
            tx.transact_to = TxKind::Call(executor);
            tx.data = bytes(&r.calldata).unwrap_or_default();
            tx.gas_limit = 30_000_000;
            tx.gas_price = num(&r.base_fee).unwrap_or_default();
            tx.chain_id = Some(r.chain_id);
        })
        .build();
    let executed = evm.transact().map_err(|_| "EVM_EXECUTION_ERROR")?;
    let success = executed.result.is_success();
    let gas = executed.result.gas_used();
    let output = executed
        .result
        .output()
        .map(|b| format!("{b:#x}"))
        .unwrap_or_else(|| "0x".into());
    let logs=match &executed.result { ExecutionResult::Success{logs,..} => logs.iter().map(|l|json!({"address":format!("{:#x}",l.address),"topics":l.data.topics().iter().map(|v|format!("{v:#x}")).collect::<Vec<_>>(),"data":format!("{:#x}",l.data.data)})).collect::<Vec<_>>(),_=>vec![] };
    Ok(
        json!({"version":1,"success":success,"gas_used":gas.to_string(),"output":output,"logs":logs,"engine":"revm-19.7.0/cancun","chain_native":false}),
    )
}
fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    for line in stdin.lock().take(1_000_001).lines() {
        let result = match line {
            Ok(l) if l.len() <= 1_000_000 => serde_json::from_str::<Request>(&l)
                .map_err(|_| "INVALID_REQUEST".to_string())
                .and_then(simulate),
            _ => Err("INPUT_BUDGET".into()),
        };
        let response = match result {
            Ok(data) => json!({"ok":true,"data":data}),
            Err(code) => json!({"ok":false,"error":code}),
        };
        if writeln!(stdout, "{response}").is_err() || stdout.flush().is_err() {
            break;
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_quantities() {
        assert_eq!(num("0x10").unwrap(), U256::from(16));
        assert!(addr("wrong").is_err());
        assert!(bytes("no").is_err());
    }
    #[test]
    fn unsigned_bytecode_reverts_and_tax_arithmetic() {
        use revm::db::InMemoryDB;
        for (code, expected) in [("0x60006000fd", false), ("0x60006000f3", true)] {
            let destination = Address::from([1u8; 20]);
            let mut db = InMemoryDB::default();
            db.insert_account_info(
                destination,
                AccountInfo {
                    code: Some(Bytecode::new_raw(bytes(code).unwrap())),
                    ..Default::default()
                },
            );
            let mut evm = Evm::builder()
                .with_db(db)
                .modify_tx_env(|tx| {
                    tx.transact_to = TxKind::Call(destination);
                    tx.gas_limit = 100000;
                })
                .build();
            assert_eq!(evm.transact().unwrap().result.is_success(), expected);
        }
    }
}

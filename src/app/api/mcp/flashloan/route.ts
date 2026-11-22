import { publicMcpHandler } from '@/lib/mcp/flashloan/public-mcp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = publicMcpHandler;
export const OPTIONS = publicMcpHandler;
export const GET = publicMcpHandler;
export const DELETE = publicMcpHandler;

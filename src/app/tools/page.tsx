import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { listSkillManifests, getSkillInstall } from '@/lib/skills';
import { isMcpSkillsEnabled } from '@/lib/platform-flag';
import CopyButton from '@/components/CopyButton';

export const metadata: Metadata = {
  title: 'Tools — HyperMove agent-skill catalog',
  description:
    'Browse harness-wrapped agent-skills. Install into any MCP agent in one paste; every skill runs inside the HyperMove harness (observability + sentinel + output-enforcement).',
};

/** Catalog sections in display order. */
const SECTIONS = [
  { id: 'harness-primitive', title: 'Harness primitives', blurb: 'The runtime every skill runs inside — adopt one capability at a time.' },
  { id: 'business-model', title: 'Business models', blurb: 'Productized playbooks composed from the primitives.' },
] as const;

type Manifest = ReturnType<typeof listSkillManifests>[number];

/** Map a manifest's harness declaration to human-readable badges. */
function harnessBadges(h: Manifest['harness']): string[] {
  const badges: string[] = [];
  if (h.errorHandler) badges.push('error-handler');
  if (h.policy) badges.push('sentinel');
  if (h.outputEnforcer) badges.push('output-enforcer');
  if (h.docExtract) badges.push('doc-extract');
  return badges;
}

function SkillCard({ skill }: { skill: Manifest }) {
  const install = getSkillInstall(skill.name);
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-hm-accent bg-white p-6 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-heading text-lg font-semibold text-hm-primary">{skill.name}</h3>
          <code className="font-mono text-xs text-hm-purple">skill.{skill.name}</code>
        </div>
        <span className="shrink-0 rounded-full border border-hm-accent bg-hm-muted px-2.5 py-0.5 text-xs font-mono text-hm-grey">
          {skill.price ?? 'free'}
        </span>
      </div>

      <p className="text-sm text-hm-grey">{skill.description}</p>

      <div className="flex flex-wrap gap-1.5">
        {harnessBadges(skill.harness).map((b) => (
          <span key={b} className="rounded border border-cyan-500/30 bg-cyan-50 px-2 py-0.5 text-xs font-mono text-cyan-700">{b}</span>
        ))}
        <span className="rounded border border-hm-accent bg-hm-muted px-2 py-0.5 text-xs font-mono uppercase text-hm-dark">{skill.tier}</span>
      </div>

      {skill.composes.length > 0 && (
        <p className="text-xs text-hm-grey">
          Composes: <span className="font-mono">{skill.composes.join(', ')}</span>
        </p>
      )}

      <div className="mt-auto flex flex-wrap gap-2 pt-2">
        {install && <CopyButton text={install.installPrompt} label="Copy install prompt" />}
        <a
          href={`/api/skills/${skill.name}?format=md`}
          className="inline-flex items-center rounded-lg border border-hm-accent px-3 py-1.5 text-xs font-medium text-hm-dark transition-colors hover:bg-hm-muted"
        >
          SKILL.md
        </a>
      </div>
    </div>
  );
}

export default function ToolsPage() {
  if (!isMcpSkillsEnabled()) {
    return (
      <div className="section-container pt-28 pb-16">
        <h1 className="font-heading text-3xl font-bold text-hm-primary">Tools</h1>
        <p className="mt-3 text-hm-grey">
          The skill catalog is disabled. Set <code className="font-mono text-hm-purple">FEATURE_HYPERMOVE_TOOLS=true</code> to enable it.
        </p>
      </div>
    );
  }

  const manifests = listSkillManifests();

  return (
    <div className="section-container pt-28 pb-20">
      {/* Header */}
      <span className="inline-block rounded-full border border-hm-accent bg-hm-muted px-3 py-1 text-xs font-mono uppercase tracking-wider text-hm-grey">
        Tools · Harness-wrapped agent skills
      </span>
      <h1 className="mt-4 font-heading text-4xl font-bold text-hm-primary sm:text-5xl">
        Install a skill. <span className="text-hm-purple">Run it inside the harness.</span>
      </h1>
      <p className="mt-4 max-w-2xl text-hm-grey">
        Every skill installs into any of 20+ MCP agents from one paste and runs as the tool{' '}
        <code className="font-mono text-hm-purple">skill.&lt;name&gt;</code> inside the HyperMove harness — observability error-capture,
        sentinel policy, and output-enforcement. Machine-readable at{' '}
        <a href="/api/skills" className="font-mono text-hm-purple hover:opacity-80">/api/skills</a>.
      </p>

      {/* Generate CTA */}
      <div className="mt-8 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-hm-purple/20 bg-hm-purple/5 p-5">
        <div>
          <h2 className="font-heading text-lg font-bold text-hm-primary">Generate a tool from any URL</h2>
          <p className="mt-1 text-sm text-hm-grey">Paste a dApp link → scan → get an agent-callable MCP config.</p>
        </div>
        <Link
          href="/tools/generate"
          className="inline-flex items-center gap-1.5 rounded-lg bg-hm-purple px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-hm-purple/90"
        >
          Open Generator <ArrowRight className="h-4 w-4" />
        </Link>
      </div>

      {/* Catalog by section */}
      {SECTIONS.map((section) => {
        const skills = manifests.filter((m) => m.category === section.id);
        if (skills.length === 0) return null;
        return (
          <section key={section.id} className="mt-12">
            <h2 className="font-heading text-2xl font-bold text-hm-primary">{section.title}</h2>
            <p className="mt-1 text-sm text-hm-grey">{section.blurb}</p>
            <div className="mt-6 grid gap-6 md:grid-cols-2">
              {skills.map((s) => (
                <SkillCard key={s.name} skill={s} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

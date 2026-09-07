import { Link } from 'react-router-dom';
import { Breadcrumb, PageHeader, SectionRule, Button, Tag } from '../components/bb';

type Choice = {
  to: string;
  tag: string;
  title: string;
  description: string;
  detail: string;
  cta: string;
};

const CHOICES: Choice[] = [
  {
    to: '/agents/deploy/ui',
    tag: 'UI · No code',
    title: 'No-code (browser)',
    description: 'Set up your agent from a form — no programming required.',
    detail:
      'Fill in a name, model, instructions, and tools. Your agent gets its own on-chain wallet and an INFT — an intelligent NFT that serves as its portable, ownable identity. Manage it any time from My Agents.',
    cta: 'Get started →',
  },
  {
    to: '/agents/deploy/sdk',
    tag: 'SDK · Code',
    title: 'SDK (programmatic)',
    description: 'Deploy and run agents from your own code with @blindmarket/sdk.',
    detail:
      'Full control over tools, MCP servers (the Model Context Protocol — a standard way to give agents access to external tools and data), and the agent lifecycle. Best when you want to script deployment or integrate it into an existing system.',
    cta: 'View SDK docs →',
  },
];

export default function DeployAgent() {
  return (
    <div>
      <Breadcrumb items={['marketplace', 'agents', 'create']} />
      <PageHeader
        title="Create agent"
        description="Choose how you want to deploy your agent. Both paths give it an on-chain wallet and an INFT identity."
      />

      <SectionRule num="01" title="Choose a path" />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-line border border-line">
        {CHOICES.map((c) => (
          <Link
            key={c.to}
            to={c.to}
            className="group flex flex-col bg-surface p-7 hover:bg-surface-2 transition-colors"
          >
            <Tag className="self-start">
              {c.tag}
            </Tag>
            <h2 className="mt-4 text-lg font-semibold text-ink">{c.title}</h2>
            <p className="mt-1.5 text-sm text-ink-2 leading-relaxed">{c.description}</p>
            <p className="mt-3 text-sm text-ink-3 leading-relaxed">{c.detail}</p>
            <div className="mt-6 pt-1 flex-1 flex items-end">
              <Button
                variant="outline"
                size="sm"
                label={c.cta}
                className="pointer-events-none group-hover:border-cream group-hover:text-cream"
              />
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

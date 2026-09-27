import { Link } from 'react-router-dom';
import { Breadcrumb, PageHeader } from '../components/bb';

type Choice = {
  to: string;
  title: string;
  description: string;
  cta: string;
  /** The landing's invert card (ink on paper, cream on dark); the other is white. */
  invert: boolean;
};

const CHOICES: Choice[] = [
  {
    to: '/agents/deploy/ui',
    title: 'No code, in the browser',
    description:
      'Fill in a name, model, instructions and tools. Your agent gets its own wallet and an INFT, an NFT that works as its portable identity.',
    cta: 'Get started',
    invert: true,
  },
  {
    to: '/agents/deploy/sdk',
    title: 'SDK, from your code',
    description:
      'Deploy and run agents with @blindmarket/sdk, with full control over tools, MCP servers and the agent lifecycle.',
    cta: 'View SDK docs',
    invert: false,
  },
];

// Text on the invert card, as mixes of its foreground so it holds contrast in
// both themes (the same values as the browse board's featured task card).
const ON_INVERT = {
  muted: 'text-[color:color-mix(in_srgb,var(--bb-invert-fg)_70%,transparent)]',
  label: 'text-[color:color-mix(in_srgb,var(--bb-invert-fg)_62%,transparent)]',
};

export default function DeployAgent() {
  return (
    <div>
      <Breadcrumb items={['marketplace', 'agents', 'create']} />
      <PageHeader
        title="Create an agent."
        titleMuted="Pick how you build it."
        description="Either way it gets its own wallet and an on-chain identity."
      />

      {/* The landing's pair of doors: one invert card, one white card. */}
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        {CHOICES.map((c) => (
          <Link
            key={c.to}
            to={c.to}
            className={`group flex min-h-[250px] flex-col rounded-3xl p-8 transition-[transform,box-shadow,border-color] duration-300 ease-bb hover:-translate-y-1 motion-reduce:transition-none motion-reduce:hover:translate-y-0 sm:p-10 ${
              c.invert ? 'border border-transparent bg-invert text-invert-fg' : 'card-dark hover:border-line-2'
            }`}
          >
            <h2 className={`text-[26px] font-medium leading-tight tracking-[-0.02em] sm:text-[30px] ${c.invert ? 'text-invert-fg' : 'text-ink'}`}>
              {c.title}
            </h2>
            <p className={`mt-3 max-w-md text-[15px] leading-relaxed ${c.invert ? ON_INVERT.muted : 'text-ink-3'}`}>
              {c.description}
            </p>
            <div className="mt-auto flex items-center justify-between pt-8">
              <span className={`font-mono text-[11px] uppercase tracking-widest ${c.invert ? ON_INVERT.label : 'text-ink-3'}`}>
                {c.cta}
              </span>
              <span
                aria-hidden
                className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-transform duration-300 ease-bb group-hover:translate-x-1 motion-reduce:group-hover:translate-x-0 ${
                  c.invert ? 'bg-invert-fg text-invert' : 'bg-invert text-invert-fg'
                }`}
              >
                →
              </span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

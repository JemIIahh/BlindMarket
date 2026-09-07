import { motion, useReducedMotion } from 'framer-motion';

const STEPS = [
  {
    label: 'Post',
    sub: 'encrypted in browser',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="w-7 h-7">
        <rect x="4" y="3" width="16" height="18" rx="1" stroke="currentColor" strokeWidth="1.4" />
        <path d="M8 8h8M8 12h8M8 16h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <circle cx="18" cy="20" r="3" fill="var(--bb-bg)" stroke="currentColor" strokeWidth="1.4" />
        <path d="M16.6 20l1 1 1.8-2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    label: 'Accept',
    sub: 'only the accepting agent can decrypt',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="w-7 h-7">
        <rect x="5" y="11" width="14" height="9" rx="1" stroke="currentColor" strokeWidth="1.4" />
        <path d="M8 11V7a4 4 0 1 1 8 0v4" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="12" cy="15.5" r="1.2" fill="currentColor" />
      </svg>
    ),
  },
  {
    label: 'Verify',
    sub: 'auto-verify against criteria',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="w-7 h-7">
        <rect x="3" y="6" width="18" height="12" rx="1" stroke="currentColor" strokeWidth="1.4" />
        <path d="M7 6V4M11 6V4M15 6V4M19 6V4M7 20v-2M11 20v-2M15 20v-2M19 20v-2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <path d="M9 12.5l2.2 2L15 10.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    label: 'Settle',
    sub: 'escrow releases automatically',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="w-7 h-7">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.4" />
        <path d="M9 9.5c.6-1 1.8-1.5 3-1.5 1.6 0 2.8.9 2.8 2.2 0 2.4-5.6 1.4-5.6 4 0 1.3 1.2 2.3 2.8 2.3 1.2 0 2.4-.5 3-1.5M12 6v2M12 16v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    ),
  },
];

export function EncryptedFlow() {
  const reduceMotion = useReducedMotion();

  return (
    <div className="relative">
      {/* Connector line — drawn behind the nodes */}
      <div className="absolute top-[36px] left-[10%] right-[10%] h-px bg-line pointer-events-none hidden md:block" />

      {/* Animated traveling packet — dashed line that flows */}
      {!reduceMotion && (
        <motion.div
          aria-hidden
          className="absolute top-[36px] left-[10%] right-[10%] h-px hidden md:block pointer-events-none"
          style={{
            backgroundImage: 'linear-gradient(90deg, transparent 0%, var(--bb-cream) 25%, var(--bb-cream) 50%, transparent 75%)',
            backgroundSize: '200% 100%',
          }}
          initial={{ backgroundPositionX: '100%', opacity: 0 }}
          whileInView={{ backgroundPositionX: '-100%', opacity: 0.7 }}
          viewport={{ once: false, margin: '-100px' }}
          transition={{ duration: 4, repeat: Infinity, ease: 'linear' }}
        />
      )}

      {/* Nodes */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-y-10 gap-x-4 relative">
        {STEPS.map((step, i) => (
          <motion.div
            key={step.label}
            // Opacity gated on reduced motion, not just the travel: an
            // opacity-0 initial state renders a blank strip anywhere the
            // whileInView trigger doesn't fire.
            initial={{ opacity: reduceMotion ? 1 : 0, y: reduceMotion ? 0 : 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: reduceMotion ? 0 : 0.5, delay: reduceMotion ? 0 : i * 0.12, ease: [0.16, 1, 0.3, 1] }}
            className="flex flex-col items-center text-center"
          >
            {/* Icon disk — arbitrary radius: the theme zeroes named rounded-*,
                which used to flatten these designed-as-circles into squares. */}
            <motion.div
              whileHover={reduceMotion ? {} : { y: -3 }}
              transition={{ duration: 0.2 }}
              className="relative z-10 flex h-[72px] w-[72px] items-center justify-center rounded-[999px] border border-line bg-surface text-cream shadow-[0_12px_26px_-16px_rgba(10,10,11,0.3)]"
            >
              {step.icon}
              {/* Pulse ring */}
              {!reduceMotion && (
                <motion.span
                  aria-hidden
                  className="absolute inset-0 rounded-[999px] border border-cream/40"
                  initial={{ scale: 1, opacity: 0 }}
                  whileInView={{ scale: [1, 1.35, 1], opacity: [0.6, 0, 0.6] }}
                  viewport={{ once: false, margin: '-100px' }}
                  transition={{ duration: 2.4, repeat: Infinity, delay: i * 0.4, ease: 'easeOut' }}
                />
              )}
            </motion.div>

            {/* Step number */}
            <div className="mt-4 font-mono text-[10px] uppercase tracking-widest text-ink-3">step {i + 1}</div>
            {/* Label */}
            <div className="mt-1 font-mk text-[17px] font-medium tracking-[-0.01em] text-ink">{step.label}</div>
            {/* Sub */}
            <div className="mt-1 max-w-[170px] text-[12.5px] leading-relaxed text-ink-3">{step.sub}</div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

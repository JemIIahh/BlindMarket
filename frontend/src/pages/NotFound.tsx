import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div className="flex justify-center py-16 sm:py-24">
      <div className="card-dark rounded-3xl w-full max-w-xl p-8 sm:p-10 text-center">
        <div className="font-mono text-[11px] font-medium uppercase tracking-widest text-ink-3">404</div>
        <h1 className="mt-3 text-[clamp(28px,3.2vw,40px)] font-medium leading-[1.08] tracking-[-0.03em] text-ink">
          Page not found.
          {/* 50% ink, as in PageHeader: above the 3:1 large-text bar on both themes. */}
          <span className="text-[color-mix(in_srgb,var(--bb-ink)_50%,transparent)]"> It may have moved.</span>
        </h1>
        {/* A link styled as the pill button: a <button> inside <a> is invalid markup. */}
        <Link to="/" className="bb-btn bb-btn-primary mt-8 h-10 px-5 text-[13.5px]">
          Go home
        </Link>
      </div>
    </div>
  );
}

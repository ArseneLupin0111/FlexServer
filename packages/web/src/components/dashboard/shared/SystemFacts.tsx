export function SystemFacts({ facts, label = "System details" }: { facts: ReadonlyArray<{ label: string; value: string }>; label?: string }) {
  return (
    <section aria-label={label} className="min-w-0 border border-line bg-panel">
      <dl className="grid min-w-0 grid-cols-2 gap-px bg-line lg:grid-cols-4">
        {facts.map((fact) => (
          <div
            key={fact.label}
            className="min-w-0 bg-panel p-4 transition-colors duration-160 ease-out hover:bg-raised/40"
          >
            <dt className="text-[11px] uppercase tracking-[0.14em] text-dim">{fact.label}</dt>
            <dd className="tnum mt-1.5 break-words text-[13px] text-text" title={fact.value}>
              {fact.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

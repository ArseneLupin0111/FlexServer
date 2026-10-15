import { cn } from "../../../lib/utils";

export type FactSpan = 1 | 2 | 3 | 4 | "full";

export type FactItem = {
  label: string;
  value: string;
  span?: FactSpan;
  className?: string;
};

export type FactGroup = {
  group: string;
  items: ReadonlyArray<FactItem>;
};

function getSpanClasses(item: FactItem): string {
  if (item.className) return item.className;
  switch (item.span) {
    case "full":
    case 4:
      return "col-span-1 sm:col-span-2 lg:col-span-4";
    case 3:
      return "col-span-1 sm:col-span-1 lg:col-span-3";
    case 2:
      return "col-span-1 sm:col-span-2 lg:col-span-2";
    default:
      return "col-span-1";
  }
}

export function SystemFacts({
  facts,
  groups,
  label = "System details",
}: {
  facts?: ReadonlyArray<FactItem>;
  groups?: ReadonlyArray<FactGroup>;
  label?: string;
}) {
  const resolvedGroups: ReadonlyArray<FactGroup> =
    groups && groups.length > 0
      ? groups
      : facts && facts.length > 0
        ? [{ group: label, items: facts }]
        : [];

  if (resolvedGroups.length === 0) return null;

  return (
    <section aria-label={label} className="min-w-0 border border-line bg-panel">
      <header className="border-b border-line px-4 py-3">
        <h2 className="text-[14px] font-semibold text-text">{label}</h2>
      </header>
      <div className="divide-y divide-line">
        {resolvedGroups.map((g) => (
          <div key={g.group} className="min-w-0">
            {resolvedGroups.length > 1 ? (
               <div className="border-b border-line bg-raised/20 px-4 py-2">
                 <h3 className="text-[11px] font-semibold uppercase tracking-wider text-dim">
                   {g.group}
                 </h3>
               </div>
             ) : null}
            <dl className="grid min-w-0 grid-cols-1 gap-px bg-line sm:grid-cols-2 lg:grid-cols-4">
               {g.items.map((fact) => (
                 <div
                   key={fact.label}
                  className={cn(
                    "min-w-0 bg-panel p-4 transition-colors duration-160 ease-out hover:bg-raised/40",
                    getSpanClasses(fact),
                  )}
                 >
                   <dt className="text-[11px] uppercase tracking-[0.14em] text-dim">
                     {fact.label}
                   </dt>
                   <dd
                     className="tnum mt-1.5 break-words [overflow-wrap:anywhere] text-[13px] text-text"
                     title={fact.value}
                   >
                     {fact.value}
                   </dd>
                 </div>
               ))}
             </dl>
           </div>
         ))}
       </div>
     </section>
   );
 }

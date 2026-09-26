// A wire unit's exact bytes by id (D10, D34), or why they cannot be shown:
// purged, withheld under the results opt-out, or never on the wire.
import { useEffect, useState } from 'react';
import type { LogUnit } from '../../../../packages/backend/dist/index.js';
import type { BackendClient } from '../lib/client';
import { RawViewer } from '../log/RawViewer';

export function UnitBytes({ client, unitId, label, missing }: { client: BackendClient; unitId: number | null; label: string; missing: string }) {
  const [unit, setUnit] = useState<LogUnit | null | undefined>(undefined);
  useEffect(() => {
    if (unitId === null) return;
    let stale = false;
    client.request('log.get', { id: unitId }).then((u) => { if (!stale) setUnit(u); }, () => { if (!stale) setUnit(null); });
    return () => { stale = true; };
  }, [client, unitId]);
  if (unitId === null) return <p className="muted">{missing}</p>;
  if (unit === undefined) return <p className="muted">Loading {label.toLowerCase()}</p>;
  if (unit === null) return <p className="muted">{label}: purged from the wire log.</p>;
  if (unit.bytes === null) return <p className="muted">{label}: withheld, this workspace does not keep results. The wire log still shows it happened.</p>;
  return (
    <>
      <p className="muted entry-source">{label}: exact bytes, wire log unit {unit.id}</p>
      <RawViewer bytes={unit.bytes} height={Math.min(320, 40 + 18 * Math.ceil(unit.byteLength / 120))} />
    </>
  );
}

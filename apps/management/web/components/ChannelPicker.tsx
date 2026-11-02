import { cx } from "@tvsm/ui";
import type { Channel } from "../lib";

export function ChannelTabs({ channels, value, onChange }: { channels: Channel[]; value: Channel | null; onChange: (id: number) => void }) {
  if (channels.length < 2) return null;
  return (
    <div className="mb-5 flex flex-wrap gap-2">
      {channels.map((c) => (
        <button
          key={c.id}
          onClick={() => onChange(c.id)}
          className={cx("flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm font-medium transition", value?.id === c.id ? "border-brand bg-brand text-white" : "border-line bg-surface hover:border-brand/50")}
        >
          <span className="size-2.5 rounded-full" style={{ background: c.color }} />
          {c.name}
        </button>
      ))}
    </div>
  );
}

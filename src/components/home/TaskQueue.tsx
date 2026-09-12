/**
 * "What is waiting for you" — the work queue both sides get.
 *
 * Every verified supply-side product in the research (Etsy, eBay, Amazon,
 * Uber, Airbnb) splits the logged-in home into a work queue and a standing
 * view, and none of them blend the two. This is the queue half.
 *
 * It renders nothing when there is nothing waiting. That is the point: an
 * empty queue should disappear, not display a row of zeros.
 */
import Link from "next/link";
import { t } from "@/lib/labels";
import type { Task } from "@/lib/home-stage";
import { Card, Num } from "@/components/ui";

export function TaskQueue({ title, tasks }: { title: string; tasks: Task[] }) {
  if (tasks.length === 0) return null;

  return (
    <section className="mb-6">
      <h2 className="font-semibold text-ink-900 mb-3">{title}</h2>
      <div className="grid sm:grid-cols-2 gap-3">
        {tasks.map((task) => (
          <Link key={task.kind} href={task.href} className="block">
            <Card
              interactive
              className="p-4 flex items-center gap-3 h-full border-s-2 border-s-brand-500"
            >
              <span className="text-2xl font-semibold text-ink-900 tabular-nums">
                <Num>{task.count}</Num>
              </span>
              <span className="text-sm text-ink-700">{t(`task.${task.kind}`)}</span>
            </Card>
          </Link>
        ))}
      </div>
    </section>
  );
}

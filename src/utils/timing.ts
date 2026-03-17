/**
 * Lightweight timing utility for measuring operation durations.
 *
 * Usage:
 *   const t = new TimingCollector();
 *   t.start("operation_name");
 *   // ... do work ...
 *   t.end("operation_name");
 *   t.logTable("Upload");
 */

export interface TimingEntry {
  label: string;
  durationMs: number;
}

export class TimingCollector {
  private entries: TimingEntry[] = [];
  private marks: Map<string, number> = new Map();

  /** Mark the start of a timed operation. */
  start(label: string): void {
    this.marks.set(label, performance.now());
  }

  /** Mark the end of a timed operation. Returns duration in ms. */
  end(label: string): number {
    const startTime = this.marks.get(label);
    if (startTime === undefined) {
      console.warn(`[Timing] No start mark for "${label}"`);
      return 0;
    }
    const duration = Math.round((performance.now() - startTime) * 100) / 100;
    this.entries.push({ label, durationMs: duration });
    this.marks.delete(label);
    return duration;
  }

  /** Get all collected timing entries. */
  getResults(): TimingEntry[] {
    return [...this.entries];
  }

  /** Log a formatted table to the console. */
  logTable(title: string): void {
    console.log(`\n⏱ ${title} Timing Results`);
    console.table(
      this.entries.reduce(
        (acc, e) => {
          acc[e.label] = { "Duration (ms)": e.durationMs };
          return acc;
        },
        {} as Record<string, { "Duration (ms)": number }>
      )
    );
  }

  /** Reset all entries and marks. */
  reset(): void {
    this.entries = [];
    this.marks.clear();
  }
}

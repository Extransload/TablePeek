import { addActivity } from "./activity";
import { t } from "./i18n";

export type JobStatus = "running" | "done" | "error" | "cancelled";

export interface Job {
  id: string;
  label: string;
  detail: string;
  total: number;
  done: number;
  status: JobStatus;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  // The job watches its handle's signal, so the queue can offer to stop it.
  cancellable: boolean;
}

export interface JobHandle {
  readonly id: string;
  // Aborted once the job is stopped; the work checks it between steps.
  readonly signal: AbortSignal;
  update(done: number, detail?: string, total?: number): void;
  finish(): void;
  fail(message: string): void;
}

export interface JobOptions {
  cancellable?: boolean;
}

type Listener = (jobs: Job[]) => void;

let jobSeq = 0;
let jobs: Job[] = [];
const listeners = new Set<Listener>();
const controllers = new Map<string, AbortController>();

function emit(): void {
  const snapshot = jobs.slice();
  for (const listener of listeners) {
    listener(snapshot);
  }
}

export function subscribeJobs(listener: Listener): () => void {
  listeners.add(listener);
  listener(jobs.slice());
  return () => {
    listeners.delete(listener);
  };
}

export function jobsSnapshot(): Job[] {
  return jobs.slice();
}

// Only a running job changes: a stopped one ignores the work's last reports.
function patchRunning(id: string, patch: (job: Job) => Job): boolean {
  const job = jobs.find((entry) => entry.id === id);
  if (job === undefined || job.status !== "running") {
    return false;
  }
  jobs = jobs.map((entry) => (entry.id === id ? patch(entry) : entry));
  return true;
}

export function startJob(label: string, detail: string, total: number, options: JobOptions = {}): JobHandle {
  jobSeq += 1;
  const id = `job-${jobSeq}`;
  const controller = new AbortController();
  controllers.set(id, controller);
  const job: Job = {
    id,
    label,
    detail,
    total,
    done: 0,
    status: "running",
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
    cancellable: options.cancellable ?? false,
  };
  jobs = [job, ...jobs];
  emit();
  return {
    id,
    signal: controller.signal,
    update(done, nextDetail, nextTotal) {
      if (
        patchRunning(id, (entry) => ({
          ...entry,
          done,
          detail: nextDetail ?? entry.detail,
          total: nextTotal ?? entry.total,
        }))
      ) {
        emit();
      }
    },
    finish() {
      controllers.delete(id);
      if (
        patchRunning(id, (entry) => ({
          ...entry,
          done: entry.total,
          status: "done",
          finishedAt: Date.now(),
        }))
      ) {
        addActivity("job", job.label, job.detail);
        emit();
      }
    },
    fail(message) {
      controllers.delete(id);
      if (
        patchRunning(id, (entry) => ({ ...entry, status: "error", error: message, finishedAt: Date.now() }))
      ) {
        addActivity("job", t("{label} 실패", { label: job.label }), message);
        emit();
      }
    },
  };
}

export function cancelJob(id: string): void {
  const controller = controllers.get(id);
  controllers.delete(id);
  if (patchRunning(id, (entry) => ({ ...entry, status: "cancelled", finishedAt: Date.now() }))) {
    const job = jobs.find((entry) => entry.id === id);
    if (job !== undefined) {
      addActivity("job", t("{label} 중지", { label: job.label }), job.detail);
    }
    emit();
  }
  controller?.abort();
}

export function clearFinishedJobs(): void {
  jobs = jobs.filter((job) => job.status === "running");
  emit();
}

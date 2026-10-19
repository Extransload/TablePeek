import { addActivity } from "./activity";

export type JobStatus = "running" | "done" | "error";

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
}

export interface JobHandle {
  update(done: number, detail?: string): void;
  finish(): void;
  fail(message: string): void;
}

type Listener = (jobs: Job[]) => void;

let jobSeq = 0;
let jobs: Job[] = [];
const listeners = new Set<Listener>();

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

export function startJob(label: string, detail: string, total: number): JobHandle {
  jobSeq += 1;
  const id = `job-${jobSeq}`;
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
  };
  jobs = [job, ...jobs];
  emit();
  return {
    update(done, nextDetail) {
      jobs = jobs.map((entry) =>
        entry.id === id
          ? { ...entry, done, detail: nextDetail ?? entry.detail }
          : entry,
      );
      emit();
    },
    finish() {
      jobs = jobs.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              done: entry.total,
              status: "done",
              finishedAt: Date.now(),
            }
          : entry,
      );
      addActivity("job", job.label, job.detail);
      emit();
    },
    fail(message) {
      jobs = jobs.map((entry) =>
        entry.id === id
          ? { ...entry, status: "error", error: message, finishedAt: Date.now() }
          : entry,
      );
      addActivity("job", `${job.label} 실패`, message);
      emit();
    },
  };
}

export function clearFinishedJobs(): void {
  jobs = jobs.filter((job) => job.status === "running");
  emit();
}

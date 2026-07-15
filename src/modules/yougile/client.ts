import { env } from "../../config/env.js";

export interface YouGileTaskInput {
  title: string;
  columnId: string;
  description?: string;
  deadline?: { deadline: number; startDate?: number };
  assigned?: string[];
}

export class YouGileError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`YouGile request failed with status ${status}`);
  }
}

export class YouGileClient {
  private queue: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const scheduled = this.queue.then(async () => {
      const delay = Math.max(0, this.nextRequestAt - Date.now());
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      // YouGile allows 50 requests/min/company. Keep a small safety margin at 48/min.
      this.nextRequestAt = Date.now() + 1_250;
    });
    this.queue = scheduled.catch(() => undefined);
    await scheduled;

    if (!env.YOUGILE_API_KEY) throw new Error("YouGile is not configured");
    const response = await fetch(`${env.YOUGILE_BASE_URL.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.YOUGILE_API_KEY}`,
        ...init.headers,
      },
    });
    const body = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) throw new YouGileError(response.status, body);
    return body as T;
  }

  listTasks(params: Record<string, string | number | undefined> = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, String(value));
    return this.request<unknown>(`/tasks${query.size ? `?${query}` : ""}`);
  }

  createTask(input: YouGileTaskInput) {
    return this.request<{ id: string }>("/tasks", { method: "POST", body: JSON.stringify(input) });
  }

  updateTask(taskId: string, patch: Partial<YouGileTaskInput> & Record<string, unknown>) {
    return this.request<unknown>(`/tasks/${encodeURIComponent(taskId)}`, { method: "PUT", body: JSON.stringify(patch) });
  }

  deleteTask(taskId: string) {
    return this.request<unknown>(`/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
  }

  addComment(taskId: string, text: string) {
    return this.request<unknown>(`/tasks/${encodeURIComponent(taskId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  }
}

export const youGile = new YouGileClient();

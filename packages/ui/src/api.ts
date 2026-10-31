export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public body?: unknown) {
    super(message);
  }
}

export async function api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith("/api/auth/")) window.dispatchEvent(new Event("tvsm:unauthorized"));
    throw new ApiError(res.status, data?.error ?? "error", data?.message ?? data?.error ?? res.statusText, data);
  }
  return data as T;
}

export const get = <T>(url: string) => api<T>("GET", url);
export const post = <T>(url: string, body?: unknown) => api<T>("POST", url, body ?? {});
export const put = <T>(url: string, body?: unknown) => api<T>("PUT", url, body);
export const del = <T>(url: string) => api<T>("DELETE", url);

export function formatBytes(n?: number | null) {
  if (n == null) return "–";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

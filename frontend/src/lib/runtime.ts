export const IS_VERCEL_DEMO =
  import.meta.env.VITE_BACKEND_MODE === "vercel-demo" ||
  import.meta.env.MODE === "vercel";

export const SOCKET_SERVER_URL =
  import.meta.env.VITE_SERVER_URL || "";

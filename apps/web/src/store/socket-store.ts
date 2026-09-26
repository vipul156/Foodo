// ============================================================
// Foodo — Socket Zustand Store (Connection State)
// ============================================================

import { create } from "zustand";

interface SocketState {
  isConnected: boolean;
  lastEvent: string | null;
  setConnected: (connected: boolean) => void;
  setLastEvent: (event: string) => void;
}

export const useSocketStore = create<SocketState>()((set) => ({
  isConnected: false,
  lastEvent: null,
  setConnected: (connected) => set({ isConnected: connected }),
  setLastEvent: (event) => set({ lastEvent: event }),
}));

// ============================================================
// Foodo — UI Zustand Store (Global Client-Side UI State Only)
// ============================================================

import { create } from "zustand";

// ─── User Location ───────────────────────────────────────────

export interface IUserLocation {
  latitude: number;
  longitude: number;
  address: string;
}

interface UIState {
  // Sidebar
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;

  // Modals
  activeModal: string | null;
  openModal: (id: string) => void;
  closeModal: () => void;

  // Global loading overlay
  globalLoading: boolean;
  setGlobalLoading: (loading: boolean) => void;

  // User selected location
  userLocation: IUserLocation | null;
  setUserLocation: (location: IUserLocation) => void;
  clearUserLocation: () => void;

  // Toasts / notifications handled via sonner or shadcn toast
}

export const useUIStore = create<UIState>()((set) => ({
  // Sidebar
  sidebarOpen: false,
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),

  // Modals
  activeModal: null,
  openModal: (id) => set({ activeModal: id }),
  closeModal: () => set({ activeModal: null }),

  // Global loading
  globalLoading: false,
  setGlobalLoading: (loading) => set({ globalLoading: loading }),

  // User location
  userLocation: null,
  setUserLocation: (location) => set({ userLocation: location }),
  clearUserLocation: () => set({ userLocation: null }),
}));

// ============================================================
// Foodo — Seller Menu Page (/seller/menu)
// ============================================================

"use client";

import { useState } from "react";
import { GlassCard } from "@/components/shared/glass-card";
import { RoleGuard } from "@/components/shared/role-guard";
import {
  useGetMyRestaurant,
  useGetMenuItems,
  useCreateMenuItem,
  useToggleMenuItem,
  useDeleteMenuItem,
} from "@/features/restaurants/api";
import type { IMenuItem } from "@/types";
import {
  Loader2,
  Plus,
  Trash2,
  Check,
  X,
  IndianRupee,
  ImageUp,
  AlertCircle,
  UtensilsCrossed,
} from "lucide-react";

export default function SellerMenuPage() {
  const { data: restaurant } = useGetMyRestaurant();
  const { data: menuItems, isLoading, refetch } = useGetMenuItems(
    restaurant?._id || "",
  );
  const createItem = useCreateMenuItem();
  const toggleItem = useToggleMenuItem();
  const deleteItem = useDeleteMenuItem();

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);

  const resetForm = () => {
    setName("");
    setDescription("");
    setPrice("");
    setImageFile(null);
    setImagePreview(null);
    setShowForm(false);
  };

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
  };

  const handleAddItem = async () => {
    if (!name || !price || !imageFile) return;
    const formData = new FormData();
    formData.append("name", name);
    formData.append("description", description);
    formData.append("price", price);
    formData.append("file", imageFile);
    await createItem.mutateAsync(formData);
    resetForm();
    refetch();
  };

  const handleToggle = async (itemId: string) => {
    await toggleItem.mutateAsync(itemId);
    refetch();
  };

  const handleDelete = async (itemId: string) => {
    if (!confirm("Delete this menu item?")) return;
    await deleteItem.mutateAsync(itemId);
    refetch();
  };

  if (!restaurant) {
    return (
      <RoleGuard allowedRoles={["seller"]}>
        <div className="flex flex-col items-center justify-center py-32 text-center">
          <AlertCircle className="h-12 w-12 text-destructive mb-4" />
          <h3 className="text-lg font-semibold mb-2">No Restaurant Found</h3>
          <p className="text-muted-foreground">
            Register your restaurant first in Settings.
          </p>
        </div>
      </RoleGuard>
    );
  }

  return (
    <RoleGuard allowedRoles={["seller"]}>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold">Menu Items</h2>
            <p className="text-sm text-muted-foreground mt-1">
              {menuItems?.length || 0} item(s) ·{" "}
              {restaurant.isOpen ? "Restaurant open" : "Restaurant closed"}
            </p>
          </div>
          <button
            onClick={() => setShowForm(!showForm)}
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:brightness-110 transition-all"
          >
            <Plus className="h-4 w-4" />
            {showForm ? "Cancel" : "Add Item"}
          </button>
        </div>

        {/* Add Item Form */}
        {showForm && (
          <GlassCard className="p-5">
            <h3 className="font-semibold mb-4">New Menu Item</h3>
            <div className="space-y-3">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Item name *"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Description"
                rows={2}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
              />
              <input
                type="number"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="Price *"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <div className="flex items-center gap-3">
                {imagePreview ? (
                  <div className="relative w-16 h-16 rounded-lg overflow-hidden">
                    <img src={imagePreview} alt="" className="h-full w-full object-cover" />
                    <button onClick={() => { setImageFile(null); setImagePreview(null); }} className="absolute top-0.5 right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/50 text-white text-[10px]">✕</button>
                  </div>
                ) : (
                  <div className="flex w-16 h-16 items-center justify-center rounded-lg border-2 border-dashed border-border">
                    <ImageUp className="h-5 w-5 text-muted-foreground/50" />
                  </div>
                )}
                <label className="cursor-pointer inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent">
                  <ImageUp className="h-3.5 w-3.5" />
                  {imagePreview ? "Change" : "Upload Image *"}
                  <input type="file" accept="image/*" onChange={handleImageSelect} className="hidden" />
                </label>
              </div>
              <button
                onClick={handleAddItem}
                disabled={createItem.isPending || !name || !price || !imageFile}
                className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-primary py-2 text-sm font-medium text-primary-foreground hover:brightness-110 transition-all disabled:opacity-50"
              >
                {createItem.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Add to Menu
              </button>
            </div>
          </GlassCard>
        )}

        {/* Menu Items List */}
        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : menuItems && menuItems.length > 0 ? (
          <div className="space-y-3">
            {menuItems.map((item: IMenuItem) => (
              <GlassCard key={item._id} className="p-4">
                <div className="flex items-center gap-4">
                  {item.image && (
                    <img src={item.image} alt={item.name} className="w-16 h-16 rounded-lg object-cover shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <h4 className="font-semibold text-sm truncate">{item.name}</h4>
                      <span className="flex items-center gap-0.5 text-sm font-semibold shrink-0">
                        <IndianRupee className="h-3 w-3" />{item.price}
                      </span>
                    </div>
                    {item.description && (
                      <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{item.description}</p>
                    )}
                    <div className="flex items-center gap-2 mt-2">
                      <button
                        onClick={() => handleToggle(item._id)}
                        disabled={toggleItem.isPending}
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition-all ${
                          item.isAvailable
                            ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
                            : "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-400"
                        }`}
                      >
                        {item.isAvailable ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                        {item.isAvailable ? "Available" : "Unavailable"}
                      </button>
                      <button
                        onClick={() => handleDelete(item._id)}
                        disabled={deleteItem.isPending}
                        className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground hover:text-destructive transition-colors"
                      >
                        <Trash2 className="h-3 w-3" /> Delete
                      </button>
                    </div>
                  </div>
                </div>
              </GlassCard>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <UtensilsCrossed className="h-12 w-12 text-muted-foreground/30 mb-4" />
            <h3 className="text-lg font-semibold mb-2">No menu items yet</h3>
            <p className="text-muted-foreground max-w-sm mb-6">
              Add your first menu item to start accepting orders.
            </p>
            <button
              onClick={() => setShowForm(true)}
              className="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:brightness-110 transition-all"
            >
              <Plus className="h-4 w-4" /> Add Your First Item
            </button>
          </div>
        )}
      </div>
    </RoleGuard>
  );
}

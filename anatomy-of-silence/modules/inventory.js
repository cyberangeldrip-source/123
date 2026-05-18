/* =========================================================
 * inventory.js
 * Item inventory system: keys, batteries, tapes, misc items.
 * Supports capacity limit, item categories, and serialization.
 * ========================================================= */

export const ITEM_TYPES = {
  KEY: 'key',
  FLASHLIGHT_BATTERY: 'flashlight_battery',
  RECORDER_BATTERY: 'recorder_battery',
  TAPE: 'tape',
  FLASHLIGHT: 'flashlight',
  RECORDER: 'recorder',
  MISC: 'misc',
};

export const KEY_IDS = {
  BASEMENT: 'key_basement',
  STORAGE: 'key_storage',
  EAST_WING: 'key_east_wing',
  WEST_WING: 'key_west_wing',
};

export class Inventory {
  constructor() {
    this.items = [];       // { id, type, name, description, icon, quantity }
    this.maxSlots = 12;
    this._listeners = [];
  }

  /** Subscribe to inventory changes */
  onChange(cb) { this._listeners.push(cb); }
  _notify() { for (const cb of this._listeners) cb(this.items); }

  /** Add an item. Returns true if added, false if full. */
  add(item) {
    // Stackable items (batteries)
    const existing = this.items.find(i => i.id === item.id && i.stackable);
    if (existing) {
      existing.quantity = (existing.quantity || 1) + (item.quantity || 1);
      this._notify();
      return true;
    }
    if (this.items.length >= this.maxSlots) return false;
    this.items.push({ ...item, quantity: item.quantity || 1 });
    this._notify();
    return true;
  }

  /** Remove an item by id. Returns the removed item or null. */
  remove(id) {
    const idx = this.items.findIndex(i => i.id === id);
    if (idx === -1) return null;
    const [removed] = this.items.splice(idx, 1);
    this._notify();
    return removed;
  }

  /** Use a stackable item (decrement quantity). Returns true if used. */
  use(id) {
    const item = this.items.find(i => i.id === id);
    if (!item) return false;
    if (item.stackable) {
      item.quantity = (item.quantity || 1) - 1;
      if (item.quantity <= 0) this.remove(id);
      else this._notify();
    } else {
      this.remove(id);
    }
    return true;
  }

  /** Check if player has a specific item (by id) */
  has(id) {
    return this.items.some(i => i.id === id);
  }

  /** Check if player has a key by KEY_ID */
  hasKey(keyId) {
    return this.items.some(i => i.type === ITEM_TYPES.KEY && i.id === keyId);
  }

  /** Get all keys in inventory */
  getKeys() {
    return this.items.filter(i => i.type === ITEM_TYPES.KEY);
  }

  /** Get count of a specific item */
  count(id) {
    const item = this.items.find(i => i.id === id);
    return item ? (item.quantity || 1) : 0;
  }

  /** Serialize for save */
  serialize() {
    return this.items.map(i => ({ ...i }));
  }

  /** Restore from save data */
  deserialize(data) {
    this.items = (data || []).map(i => ({ ...i }));
    this._notify();
  }

  /** Clear all items */
  clear() {
    this.items = [];
    this._notify();
  }
}

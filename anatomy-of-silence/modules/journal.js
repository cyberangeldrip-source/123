/* =========================================================
 * journal.js
 * Notes/journal system. Tracks all found notes, tape
 * transcripts, and lore entries. Persists across saves.
 * ========================================================= */

export const JOURNAL_CATEGORIES = {
  NOTES: 'notes',
  TAPES: 'tapes',
  LORE: 'lore',
};

export class Journal {
  constructor() {
    this.entries = [];  // { id, category, title, text, foundAt (timestamp), read }
    this._listeners = [];
    this._newCount = 0;
  }

  /** Subscribe to journal changes */
  onChange(cb) { this._listeners.push(cb); }
  _notify() { for (const cb of this._listeners) cb(this.entries, this._newCount); }

  /** Add a new entry. Prevents duplicates by id. */
  addEntry(entry) {
    if (this.entries.some(e => e.id === entry.id)) return false;
    this.entries.push({
      ...entry,
      foundAt: Date.now(),
      read: false,
    });
    this._newCount++;
    this._notify();
    return true;
  }

  /** Mark an entry as read */
  markRead(id) {
    const entry = this.entries.find(e => e.id === id);
    if (entry && !entry.read) {
      entry.read = true;
      this._newCount = Math.max(0, this._newCount - 1);
      this._notify();
    }
  }

  /** Mark all as read */
  markAllRead() {
    for (const e of this.entries) e.read = true;
    this._newCount = 0;
    this._notify();
  }

  /** Get entries by category */
  getByCategory(category) {
    return this.entries.filter(e => e.category === category);
  }

  /** Get unread count */
  get unreadCount() { return this._newCount; }

  /** Check if a specific entry exists */
  has(id) { return this.entries.some(e => e.id === id); }

  /** Serialize for save */
  serialize() {
    return {
      entries: this.entries.map(e => ({ ...e })),
      newCount: this._newCount,
    };
  }

  /** Restore from save data */
  deserialize(data) {
    if (!data) return;
    this.entries = (data.entries || []).map(e => ({ ...e }));
    this._newCount = data.newCount || 0;
    this._notify();
  }

  /** Clear all */
  clear() {
    this.entries = [];
    this._newCount = 0;
    this._notify();
  }
}

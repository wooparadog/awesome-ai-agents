-- Keep the reported hostname separate from a user-selected installation label.
ALTER TABLE installations ADD COLUMN hostname TEXT;

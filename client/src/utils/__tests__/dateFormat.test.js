import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatRelativeTime, formatFullDate, formatSyncDate, formatSyncDateLong } from '../dateFormat.js';

describe('dateFormat', () => {
  describe('formatRelativeTime', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-30T12:00:00Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns empty string for falsy input', () => {
      expect(formatRelativeTime(null)).toBe('');
      expect(formatRelativeTime('')).toBe('');
      expect(formatRelativeTime(undefined)).toBe('');
    });

    it('returns "just now" for recent timestamps', () => {
      expect(formatRelativeTime('2026-03-30T11:59:30Z')).toBe('just now');
    });

    it('returns minutes ago', () => {
      expect(formatRelativeTime('2026-03-30T11:55:00Z')).toBe('5m ago');
    });

    it('returns hours ago', () => {
      expect(formatRelativeTime('2026-03-30T09:00:00Z')).toBe('3h ago');
    });

    it('returns days ago', () => {
      expect(formatRelativeTime('2026-03-23T12:00:00Z')).toBe('7d ago');
    });

    it('returns locale date for >30 days', () => {
      const result = formatRelativeTime('2026-01-01T12:00:00Z');
      expect(result).not.toContain('ago');
      expect(result).not.toBe('just now');
    });

    it('handles timestamps without Z suffix', () => {
      // Should append Z automatically
      expect(formatRelativeTime('2026-03-30T11:59:30')).toBe('just now');
    });
  });

  describe('formatFullDate', () => {
    it('formats a date with month name and time', () => {
      const result = formatFullDate('2026-03-15T15:45:00Z');
      // Check structural elements (exact format depends on timezone)
      expect(result).toMatch(/\d+\s+\w+\s+2026/);
      expect(result).toContain(',');
    });
  });

  describe('formatSyncDate', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-30T12:00:00'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns empty string for falsy input', () => {
      expect(formatSyncDate('')).toBe('');
      expect(formatSyncDate(null)).toBe('');
    });

    it('returns "today at ..." for today', () => {
      const result = formatSyncDate('2026-03-30T09:30:00');
      expect(result).toMatch(/^today at/);
      expect(result).toMatch(/\d+:\d+ [AP]M$/);
    });

    it('returns "yesterday at ..." for yesterday', () => {
      const result = formatSyncDate('2026-03-29T14:00:00');
      expect(result).toMatch(/^yesterday at/);
    });

    it('returns "DD Mon at ..." for older dates', () => {
      const result = formatSyncDate('2026-03-15T10:00:00');
      expect(result).toMatch(/^15 Mar at/);
    });
  });

  describe('formatSyncDateLong', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-30T12:00:00'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns empty string for falsy input', () => {
      expect(formatSyncDateLong('')).toBe('');
    });

    it('returns capitalized "Today at ..."', () => {
      const result = formatSyncDateLong('2026-03-30T09:30:00');
      expect(result).toMatch(/^Today at/);
    });

    it('returns "Yesterday at ..."', () => {
      const result = formatSyncDateLong('2026-03-29T14:00:00');
      expect(result).toMatch(/^Yesterday at/);
    });

    it('returns full month name for older dates', () => {
      const result = formatSyncDateLong('2026-03-15T10:00:00');
      expect(result).toMatch(/15 March, 2026 at/);
    });
  });
});

// @ts-check
/**
 * Format a date string as relative time (e.g. "just now", "5m ago", "3d ago").
 * @param {string} dateStr - ISO date string
 * @returns {string}
 */
export function formatRelativeTime(dateStr) {
  if (!dateStr) return '';
  const now = new Date();
  const date = new Date(dateStr.endsWith('Z') ? dateStr : dateStr + 'Z');
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

/**
 * Format a date string as a full date (e.g. "15 March 2026, 3:45 pm").
 * @param {string} dateStr - ISO date string
 * @returns {string}
 */
export function formatFullDate(dateStr) {
  const d = new Date(dateStr);
  const day = d.getDate();
  const month = d.toLocaleString('en-US', { month: 'long' });
  const year = d.getFullYear();
  const time = d.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();
  return `${day} ${month} ${year}, ${time}`;
}

/**
 * Format a date string for sync display (e.g. "today at 3:45 PM", "15 Jan at 2:00 PM").
 * @param {string} dateStr - ISO date string
 * @returns {string}
 */
export function formatSyncDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const dateDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  let dayPart;
  if (dateDay.getTime() === today.getTime()) dayPart = 'today';
  else if (dateDay.getTime() === yesterday.getTime()) dayPart = 'yesterday';
  else {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    dayPart = `${d.getDate()} ${months[d.getMonth()]}`;
  }
  const h = d.getHours() % 12 || 12;
  const m = d.getMinutes().toString().padStart(2, '0');
  const ampm = d.getHours() < 12 ? 'AM' : 'PM';
  return `${dayPart} at ${h}:${m} ${ampm}`;
}

/**
 * Format a date string for long sync display (e.g. "Today at 3:45 PM", "15 January, 2026 at 2:00 PM").
 * @param {string} dateStr - ISO date string
 * @returns {string}
 */
export function formatSyncDateLong(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const dateDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  let dayPart;
  if (dateDay.getTime() === today.getTime()) dayPart = 'Today';
  else if (dateDay.getTime() === yesterday.getTime()) dayPart = 'Yesterday';
  else {
    const months = [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ];
    dayPart = `${d.getDate()} ${months[d.getMonth()]}, ${d.getFullYear()}`;
  }
  const h = d.getHours() % 12 || 12;
  const m = d.getMinutes().toString().padStart(2, '0');
  const ampm = d.getHours() < 12 ? 'AM' : 'PM';
  return `${dayPart} at ${h}:${m} ${ampm}`;
}

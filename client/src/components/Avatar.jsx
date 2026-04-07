import React from 'react';

const COLORS = [
  '#e57373',
  '#f06292',
  '#ba68c8',
  '#9575cd',
  '#7986cb',
  '#64b5f6',
  '#4fc3f7',
  '#4dd0e1',
  '#4db6ac',
  '#81c784',
  '#aed581',
  '#ff8a65',
  '#a1887f',
  '#90a4ae',
];

/**
 * Derives a deterministic colour from a name string via hashing.
 * @param {string} name
 * @returns {string} CSS colour value
 */
function getColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return COLORS[Math.abs(hash) % COLORS.length];
}

/**
 * Extracts up to two initials from a display name.
 * @param {string} name
 * @returns {string} Uppercase initials
 */
function getInitials(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.substring(0, 2).toUpperCase();
}

export { getColor };

/** Circular avatar showing colour-coded initials derived from a user's name. */
export default function Avatar({ name, size = 32 }) {
  const safeName = name || '?';
  const color = getColor(safeName);
  const initials = getInitials(safeName);

  return (
    <div
      className="avatar"
      title={name}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        backgroundColor: color,
        color: '#000',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.4,
        fontWeight: 600,
        flexShrink: 0,
      }}
    >
      {initials}
    </div>
  );
}

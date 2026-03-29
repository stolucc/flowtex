import React, { useState, useEffect } from 'react';
import { get, post, del } from '../api.js';
import Avatar from './Avatar.jsx';

export default function ShareModal({ projectId, onClose }) {
  const [members, setMembers] = useState([]);
  const [invitations, setInvitations] = useState([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('editor');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    get(`/api/projects/${projectId}/members`)
      .then((r) => r.json())
      .then(setMembers);
    get(`/api/projects/${projectId}/invitations`)
      .then((r) => r.json())
      .then(setInvitations);
  }, [projectId]);

  const handleAdd = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    const res = await post(`/api/projects/${projectId}/members`, { email, role });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error);
    } else {
      setInvitations((inv) => [...inv, data]);
      setSuccess(`Invitation sent to ${email}`);
      setEmail('');
    }
  };

  const handleRemove = async (userId) => {
    await del(`/api/projects/${projectId}/members/${userId}`);
    setMembers((m) => m.filter((u) => u.id !== userId));
  };

  const handleCancelInvite = async (inviteId) => {
    await del(`/api/projects/${projectId}/invitations/${inviteId}`);
    setInvitations((inv) => inv.filter((i) => i.id !== inviteId));
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h2>Share Project</h2>
        <form onSubmit={handleAdd} className="share-form">
          <input
            type="email"
            placeholder="Email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="auth-input"
          />
          <select value={role} onChange={(e) => setRole(e.target.value)} className="share-role-select">
            <option value="editor">Editor</option>
            <option value="viewer">Viewer</option>
          </select>
          <button type="submit" className="auth-button">Invite</button>
        </form>
        {error && <div className="auth-error">{error}</div>}
        {success && <div className="auth-success">{success}</div>}

        <ul className="member-list">
          {members.map((m) => (
            <li key={m.id} className="member-item">
              <Avatar name={m.name} />
              <div className="member-info">
                <span className="member-name">{m.name}</span>
                <span className="member-email">{m.email}</span>
              </div>
              <span className="member-role">{m.role}</span>
              {m.role !== 'owner' && (
                <button className="member-remove" onClick={() => handleRemove(m.id)} title="Remove">
                  &times;
                </button>
              )}
            </li>
          ))}
        </ul>

        {invitations.length > 0 && (
          <>
            <h3 className="share-section-title">Pending Invitations</h3>
            <ul className="member-list">
              {invitations.map((inv) => (
                <li key={inv.id} className="member-item invitation-pending">
                  <div className="member-info">
                    <span className="member-email">{inv.email}</span>
                    <span className="invitation-status">Pending</span>
                  </div>
                  <span className="member-role">{inv.role}</span>
                  <button className="member-remove" onClick={() => handleCancelInvite(inv.id)} title="Cancel invitation">
                    &times;
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        <button className="modal-close-btn" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

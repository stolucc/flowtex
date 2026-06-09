// Admin: SAML / SSO configuration tab.
//
// Three sections, top to bottom:
//   1. SP info (entityID, cert fingerprint, copy-able URLs, Rotate)
//   2. List of configured IdPs (toggle enabled, edit, delete)
//   3. "Add new IdP" button that opens the create/edit modal
//
// The modal has two paths -- "Paste metadata XML" (default) and
// "Field-by-field" (fallback for IdPs whose metadata isn't easy to
// download).

import React, { useEffect, useState } from 'react';
import { get, post, patch, del } from '../../api.js';

const PRESETS = [
  { value: 'shibboleth', label: 'Shibboleth (academic)' },
  { value: 'entra',      label: 'Microsoft Entra / Azure AD' },
  { value: 'okta',       label: 'Okta' },
  { value: 'google',     label: 'Google Workspace' },
  { value: 'generic',    label: 'Generic / other' },
];

export default function SamlConfig() {
  const [spInfo, setSpInfo] = useState(null);
  const [idps, setIdps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);  // null | 'new' | <idpId>
  const [rotateConfirm, setRotateConfirm] = useState(false);

  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      const [spRes, listRes] = await Promise.all([
        get('/api/admin/saml/sp-info'),
        get('/api/admin/saml/idps'),
      ]);
      if (spRes.ok) setSpInfo(await spRes.json());
      if (listRes.ok) {
        const data = await listRes.json();
        setIdps(data.idps || []);
      }
    } catch (e) {
      setError('Failed to load SAML configuration.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  const handleToggleEnabled = async (idp) => {
    try {
      const res = await patch(`/api/admin/saml/idps/${idp.id}`, { enabled: !idp.enabled });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to toggle.');
        return;
      }
      refresh();
    } catch {
      setError('Failed to toggle.');
    }
  };

  const handleDelete = async (idp) => {
    if (!window.confirm(
      `Delete the "${idp.display_name}" SSO configuration?\n\n` +
      `If any users are linked to this IdP, the delete will be refused -- ` +
      `you'd need to convert them to password auth or reassign first.`
    )) return;
    try {
      const res = await del(`/api/admin/saml/idps/${idp.id}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to delete.');
        return;
      }
      refresh();
    } catch {
      setError('Failed to delete.');
    }
  };

  const handleRotate = async () => {
    try {
      const res = await post('/api/admin/saml/sp/rotate', {});
      if (!res.ok) {
        setError('Failed to rotate keypair.');
        setRotateConfirm(false);
        return;
      }
      setRotateConfirm(false);
      refresh();
    } catch {
      setError('Failed to rotate keypair.');
      setRotateConfirm(false);
    }
  };

  if (loading) return <div className="admin-loading">Loading SSO configuration…</div>;

  return (
    <div className="admin-saml">
      {error && (
        <div className="admin-error" style={{ marginBottom: 12 }}>{error}</div>
      )}

      <SpInfoCard
        spInfo={spInfo}
        rotateConfirm={rotateConfirm}
        onRotateRequest={() => setRotateConfirm(true)}
        onRotateConfirm={handleRotate}
        onRotateCancel={() => setRotateConfirm(false)}
      />

      <h3 style={{ marginTop: 24 }}>Identity Providers</h3>
      {idps.length === 0 && (
        <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>
          No SSO providers configured. Users sign in with email + password.
        </p>
      )}
      {idps.map((idp) => (
        <IdPCard
          key={idp.id}
          idp={idp}
          onEdit={() => setEditing(idp.id)}
          onDelete={() => handleDelete(idp)}
          onToggleEnabled={() => handleToggleEnabled(idp)}
        />
      ))}

      <button
        type="button"
        className="admin-button"
        style={{ marginTop: 16 }}
        onClick={() => setEditing('new')}
      >
        + Add identity provider
      </button>

      {editing && (
        <IdPEditorModal
          idpId={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh(); }}
        />
      )}
    </div>
  );
}

function SpInfoCard({ spInfo, rotateConfirm, onRotateRequest, onRotateConfirm, onRotateCancel }) {
  if (!spInfo) return null;
  return (
    <div style={{
      padding: 16,
      background: 'var(--bg-surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
    }}>
      <h3 style={{ marginTop: 0 }}>FlowTex SP information</h3>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 0 }}>
        Give these values to your identity provider when configuring SSO.
      </p>
      <CopyField label="SP entityID" value={spInfo.entityId} />
      <CopyField
        label="Metadata URL (per IdP)"
        value={spInfo.metadataUrlTemplate}
        note="Replace <idpId> with the UUID shown next to each IdP below."
      />
      <CopyField
        label="ACS URL (per IdP)"
        value={spInfo.acsUrlTemplate}
        note="Replace <idpId> with the UUID shown next to each IdP below."
      />
      <div style={{ marginTop: 12, fontSize: 13 }}>
        <strong>Certificate fingerprint (SHA-256):</strong>{' '}
        <code style={{ fontSize: 11 }}>{spInfo.fingerprintSha256}</code>
      </div>
      <div style={{ marginTop: 4, fontSize: 13, color: 'var(--text-secondary)' }}>
        Expires {new Date(spInfo.notValidAfter).toISOString().slice(0, 10)}
      </div>
      <details style={{ marginTop: 8 }}>
        <summary style={{ cursor: 'pointer', fontSize: 13 }}>Show certificate PEM</summary>
        <pre style={{
          fontSize: 10,
          padding: 8,
          marginTop: 4,
          background: 'var(--bg-primary)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          overflow: 'auto',
        }}>{spInfo.certificatePem}</pre>
      </details>
      {!rotateConfirm ? (
        <button
          type="button"
          className="admin-button"
          style={{ marginTop: 12 }}
          onClick={onRotateRequest}
        >
          Rotate keypair
        </button>
      ) : (
        <div style={{
          marginTop: 12,
          padding: 12,
          background: 'var(--bg-primary)',
          border: '1px solid var(--err)',
          borderRadius: 4,
        }}>
          <p style={{ margin: 0, fontSize: 13 }}>
            Rotating the keypair publishes a new certificate. Until your IdPs
            re-fetch the metadata, signed AuthnRequests will fail verification.
            Coordinate with each IdP admin first.
          </p>
          <div style={{ marginTop: 8 }}>
            <button type="button" className="admin-button" onClick={onRotateConfirm}>
              Yes, rotate now
            </button>
            <button
              type="button"
              className="admin-button"
              style={{ marginLeft: 8, background: 'transparent' }}
              onClick={onRotateCancel}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CopyField({ label, value, note }) {
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
        <code style={{
          flex: 1,
          padding: '4px 8px',
          fontSize: 12,
          background: 'var(--bg-primary)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          overflow: 'auto',
        }}>{value}</code>
        <button type="button" className="admin-button-small" onClick={onCopy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {note && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
          {note}
        </div>
      )}
    </div>
  );
}

function IdPCard({ idp, onEdit, onDelete, onToggleEnabled }) {
  return (
    <div style={{
      padding: 12,
      marginTop: 8,
      background: 'var(--bg-surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      display: 'flex',
      alignItems: 'center',
      gap: 12,
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600 }}>{idp.display_name}</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          ID <code style={{ fontSize: 11 }}>{idp.id}</code>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
          Domains: {(idp.allowed_email_domains || []).join(', ') || '(none)'}
        </div>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
        <input
          type="checkbox"
          checked={idp.enabled}
          onChange={onToggleEnabled}
        />
        Enabled
      </label>
      <button type="button" className="admin-button-small" onClick={onEdit}>Edit</button>
      <button
        type="button"
        className="admin-button-small"
        style={{ color: 'var(--err)' }}
        onClick={onDelete}
      >
        Delete
      </button>
    </div>
  );
}

function IdPEditorModal({ idpId, onClose, onSaved }) {
  const isNew = !idpId;
  const [mode, setMode] = useState('metadata');  // 'metadata' | 'fields'
  const [form, setForm] = useState({
    displayName: '',
    metadataXml: '',
    entityId: '',
    ssoUrl: '',
    sloUrl: '',
    certPem: '',
    attributeMapping: 'generic',
    allowedEmailDomains: '',
    jitProvisioning: true,
    enabled: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [testPreview, setTestPreview] = useState(null);

  // Load existing if editing.
  useEffect(() => {
    if (isNew) return;
    (async () => {
      try {
        const res = await get(`/api/admin/saml/idps/${idpId}`);
        if (!res.ok) return;
        const data = await res.json();
        const idp = data.idp || {};
        setForm({
          displayName: idp.display_name || '',
          metadataXml: '',  // we don't surface the original XML; user can re-paste if needed
          entityId: idp.entity_id || '',
          ssoUrl: idp.sso_url || '',
          sloUrl: idp.slo_url || '',
          certPem: idp.cert_pem || '',
          attributeMapping: idp.attribute_mapping?.preset || 'generic',
          allowedEmailDomains: (idp.allowed_email_domains || []).join(', '),
          jitProvisioning: !!idp.jit_provisioning,
          enabled: !!idp.enabled,
        });
        setMode('fields');  // editing always lands in fields mode
      } catch {
        setError('Failed to load IdP details.');
      }
    })();
  }, [idpId]);

  const handleTest = async () => {
    setError('');
    setTestPreview(null);
    try {
      const res = await post('/api/admin/saml/idps/test-metadata', {
        metadataXml: form.metadataXml,
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error || 'Metadata test failed.');
        return;
      }
      setTestPreview(data.preview);
    } catch {
      setError('Metadata test failed.');
    }
  };

  const handleSave = async () => {
    setBusy(true);
    setError('');
    const domains = form.allowedEmailDomains
      .split(/[,\s]+/)
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
    if (domains.length === 0) {
      setError('At least one email domain is required.');
      setBusy(false);
      return;
    }
    const body = {
      displayName: form.displayName,
      attributeMapping: form.attributeMapping,
      allowedEmailDomains: domains,
      jitProvisioning: form.jitProvisioning,
      enabled: form.enabled,
    };
    if (mode === 'metadata' && form.metadataXml.trim().length > 0) {
      body.metadataXml = form.metadataXml;
    } else {
      body.entityId = form.entityId;
      body.ssoUrl = form.ssoUrl;
      body.sloUrl = form.sloUrl || null;
      body.certPem = form.certPem;
    }
    try {
      const res = isNew
        ? await post('/api/admin/saml/idps', body)
        : await patch(`/api/admin/saml/idps/${idpId}`, body);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Save failed.');
        setBusy(false);
        return;
      }
      onSaved();
    } catch {
      setError('Save failed.');
      setBusy(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-primary)',
          padding: 24,
          maxWidth: 720,
          width: '90%',
          maxHeight: '90vh',
          overflow: 'auto',
          borderRadius: 'var(--radius)',
        }}
      >
        <h3 style={{ marginTop: 0 }}>{isNew ? 'Add identity provider' : 'Edit identity provider'}</h3>

        <Field
          label="Display name"
          value={form.displayName}
          onChange={(v) => setForm({ ...form, displayName: v })}
          placeholder="UCC, TCD, Acme Corp, ..."
        />

        {isNew && (
          <div style={{ marginTop: 16 }}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <button
                type="button"
                className={`admin-button-small ${mode === 'metadata' ? 'active' : ''}`}
                onClick={() => setMode('metadata')}
              >
                Paste metadata XML
              </button>
              <button
                type="button"
                className={`admin-button-small ${mode === 'fields' ? 'active' : ''}`}
                onClick={() => setMode('fields')}
              >
                Field-by-field
              </button>
            </div>
          </div>
        )}

        {mode === 'metadata' && isNew ? (
          <>
            <label style={{ display: 'block', marginTop: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Metadata XML</div>
              <textarea
                value={form.metadataXml}
                onChange={(e) => setForm({ ...form, metadataXml: e.target.value })}
                placeholder="<EntityDescriptor xmlns:md=...>..."
                rows={10}
                style={{
                  width: '100%',
                  marginTop: 4,
                  padding: 8,
                  fontFamily: 'monospace',
                  fontSize: 12,
                }}
              />
            </label>
            <button
              type="button"
              className="admin-button-small"
              style={{ marginTop: 8 }}
              onClick={handleTest}
              disabled={!form.metadataXml}
            >
              Test parse
            </button>
            {testPreview && (
              <div style={{
                marginTop: 8,
                padding: 8,
                fontSize: 12,
                background: 'var(--bg-surface)',
                border: '1px solid var(--border)',
                borderRadius: 4,
              }}>
                <div><strong>entityID:</strong> {testPreview.entityId}</div>
                <div><strong>SSO URL:</strong> {testPreview.ssoUrl}</div>
                <div><strong>SLO URL:</strong> {testPreview.sloUrl || '(none)'}</div>
                <div><strong>Certificate:</strong> <code>{testPreview.certPreview}</code></div>
              </div>
            )}
          </>
        ) : (
          <>
            <Field
              label="Entity ID"
              value={form.entityId}
              onChange={(v) => setForm({ ...form, entityId: v })}
              placeholder="https://idp.ucc.ie/idp/shibboleth"
              disabled={!isNew}
              note={!isNew ? "Entity ID is immutable -- delete + re-create the IdP if it needs to change." : null}
            />
            <Field
              label="SSO URL"
              value={form.ssoUrl}
              onChange={(v) => setForm({ ...form, ssoUrl: v })}
              placeholder="https://idp.ucc.ie/idp/profile/SAML2/POST/SSO"
            />
            <Field
              label="SLO URL (optional)"
              value={form.sloUrl}
              onChange={(v) => setForm({ ...form, sloUrl: v })}
              placeholder="https://idp.ucc.ie/idp/profile/SAML2/Redirect/SLO"
            />
            <label style={{ display: 'block', marginTop: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Certificate PEM</div>
              <textarea
                value={form.certPem}
                onChange={(e) => setForm({ ...form, certPem: e.target.value })}
                placeholder="-----BEGIN CERTIFICATE-----..."
                rows={5}
                style={{
                  width: '100%',
                  marginTop: 4,
                  padding: 8,
                  fontFamily: 'monospace',
                  fontSize: 11,
                }}
              />
            </label>
          </>
        )}

        <label style={{ display: 'block', marginTop: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Attribute mapping</div>
          <select
            value={form.attributeMapping}
            onChange={(e) => setForm({ ...form, attributeMapping: e.target.value })}
            style={{ marginTop: 4, padding: '4px 8px' }}
          >
            {PRESETS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </label>

        <Field
          label="Allowed email domains (comma- or space-separated)"
          value={form.allowedEmailDomains}
          onChange={(v) => setForm({ ...form, allowedEmailDomains: v })}
          placeholder="ucc.ie, cs.ucc.ie"
          note="Users with emails in these domains will be routed to this IdP."
        />

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 14 }}>
          <input
            type="checkbox"
            checked={form.jitProvisioning}
            onChange={(e) => setForm({ ...form, jitProvisioning: e.target.checked })}
          />
          Just-in-time user provisioning (auto-create accounts on first login)
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 14 }}>
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />
          Enabled (visible on the login page; users can sign in via this IdP)
        </label>

        {error && (
          <div className="admin-error" style={{ marginTop: 12, fontSize: 13 }}>{error}</div>
        )}

        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="admin-button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="admin-button" onClick={handleSave} disabled={busy}>
            {busy ? 'Saving...' : (isNew ? 'Create' : 'Save')}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, disabled, note }) {
  return (
    <label style={{ display: 'block', marginTop: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        style={{ width: '100%', marginTop: 4, padding: '4px 8px' }}
      />
      {note && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{note}</div>
      )}
    </label>
  );
}

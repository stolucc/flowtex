// @ts-check
// Admin: SAML / SSO configuration tab.
//
// Three sections, top to bottom:
//   1. SP info (entityID, cert fingerprint, copy-able URLs, Rotate)
//   2. List of configured IdPs (toggle enabled, edit, delete)
//   3. "Add new IdP" button that opens the create/edit modal
//
// All buttons use the existing admin/modal classes (admin-audit-btn for
// inline, modal-btn[-primary|-secondary] for modal actions). Delete and
// rotate use the inline "Are you sure?" pattern that the audit tab
// uses; per feedback_native_dialogs_banned, no window.confirm/alert.

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
  const [spInfo, setSpInfo] = useState(/** @type {any} */ (null));
  const [idps, setIdps] = useState(/** @type {any[]} */ ([]));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(/** @type {any} */ (null));  // null | 'new' | <idpId>
  const [confirmDelete, setConfirmDelete] = useState(/** @type {any} */ (null)); // <idpId> | null
  const [confirmRotate, setConfirmRotate] = useState(false);

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
    } catch {
      setError('Failed to load SAML configuration.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  const handleToggleEnabled = async (/** @type {any} */ idp) => {
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

  const handleDelete = async (/** @type {any} */ idp) => {
    try {
      const res = await del(`/api/admin/saml/idps/${idp.id}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to delete.');
        return;
      }
      setConfirmDelete(null);
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
      }
    } catch {
      setError('Failed to rotate keypair.');
    } finally {
      setConfirmRotate(false);
      refresh();
    }
  };

  if (loading) return <div className="saml-config-loading">Loading SSO configuration…</div>;

  return (
    <div className="saml-config">
      {error && (
        <div className="saml-config-error">{error}</div>
      )}

      <SpInfoCard
        spInfo={spInfo}
        confirmRotate={confirmRotate}
        onRotateRequest={() => setConfirmRotate(true)}
        onRotateConfirm={handleRotate}
        onRotateCancel={() => setConfirmRotate(false)}
      />

      <h3 className="saml-config-section-title">Identity providers</h3>
      {idps.length === 0 && (
        <p className="saml-config-empty">
          No SSO providers configured. Users sign in with email and password.
        </p>
      )}
      {idps.map((/** @type {any} */ idp) => (
        <IdPRow
          key={idp.id}
          idp={idp}
          confirmDelete={confirmDelete === idp.id}
          onEdit={() => setEditing(idp.id)}
          onDeleteRequest={() => setConfirmDelete(idp.id)}
          onDeleteConfirm={() => handleDelete(idp)}
          onDeleteCancel={() => setConfirmDelete(null)}
          onToggleEnabled={() => handleToggleEnabled(idp)}
        />
      ))}

      <div className="saml-config-actions">
        <button
          type="button"
          className="admin-audit-btn"
          onClick={() => setEditing('new')}
        >
          + Add identity provider
        </button>
      </div>

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

/** @param {any} props */
function SpInfoCard({ spInfo, confirmRotate, onRotateRequest, onRotateConfirm, onRotateCancel }) {
  if (!spInfo) return null;
  return (
    <div className="saml-config-card">
      <h3 className="saml-config-section-title">FlowTex SP information</h3>
      <p className="saml-config-hint">
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
      <div className="saml-config-meta">
        <div>
          <strong>Certificate fingerprint (SHA-256):</strong>{' '}
          <code className="saml-config-fingerprint">{spInfo.fingerprintSha256}</code>
        </div>
        <div className="saml-config-hint">
          Expires {new Date(spInfo.notValidAfter).toISOString().slice(0, 10)}
        </div>
      </div>
      <details className="saml-config-cert-details">
        <summary>Show certificate PEM</summary>
        <pre className="saml-config-cert-pem">{spInfo.certificatePem}</pre>
      </details>
      <div className="saml-config-actions">
        {!confirmRotate ? (
          <button
            type="button"
            className="admin-audit-btn"
            onClick={onRotateRequest}
          >
            Rotate keypair
          </button>
        ) : (
          <span className="saml-config-confirm">
            Rotating publishes a new certificate. Two operator actions
            required AFTER this:
            (1) every IdP must re-fetch your SP metadata or signed
            AuthnRequests will fail signature verification;
            (2) in cluster mode, every FlowTex web instance must be
            restarted (<code>sudo systemctl restart &lsquo;flowtex*&rsquo;</code>) so
            in-memory keypair caches drop the old key — otherwise about
            half of new login attempts will use the stale key.
            <button type="button" className="admin-audit-btn admin-audit-btn-danger" onClick={onRotateConfirm}>
              Rotate now
            </button>
            <button type="button" className="admin-audit-btn" onClick={onRotateCancel}>
              Cancel
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

/** @param {any} props */
function CopyField({ label, value, note }) {
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="saml-config-copy-field">
      <div className="saml-config-copy-label">{label}</div>
      <div className="saml-config-copy-row">
        <code className="saml-config-copy-value">{value}</code>
        <button type="button" className="admin-audit-btn" onClick={onCopy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {note && <div className="saml-config-hint">{note}</div>}
    </div>
  );
}

/** @param {any} props */
function IdPRow({ idp, confirmDelete, onEdit, onDeleteRequest, onDeleteConfirm, onDeleteCancel, onToggleEnabled }) {
  return (
    <div className="saml-config-idp-row">
      <div className="saml-config-idp-info">
        <div className="saml-config-idp-name">{idp.display_name}</div>
        <div className="saml-config-idp-meta">
          ID <code>{idp.id}</code>
        </div>
        <div className="saml-config-idp-meta">
          Domains: {(idp.allowed_email_domains || []).join(', ') || '(none)'}
        </div>
      </div>
      <label className="saml-config-toggle">
        <input
          type="checkbox"
          checked={idp.enabled}
          onChange={onToggleEnabled}
        />
        Enabled
      </label>
      {!confirmDelete ? (
        <>
          <button type="button" className="admin-audit-btn" onClick={onEdit}>Edit</button>
          <button
            type="button"
            className="admin-audit-btn admin-audit-btn-danger"
            onClick={onDeleteRequest}
          >
            Delete
          </button>
        </>
      ) : (
        <span className="saml-config-confirm">
          Delete &ldquo;{idp.display_name}&rdquo;?
          <button type="button" className="admin-audit-btn admin-audit-btn-danger" onClick={onDeleteConfirm}>
            Yes
          </button>
          <button type="button" className="admin-audit-btn" onClick={onDeleteCancel}>
            Cancel
          </button>
        </span>
      )}
    </div>
  );
}

/** @param {any} props */
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
  const [testPreview, setTestPreview] = useState(/** @type {any} */ (null));

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
          metadataXml: '',
          entityId: idp.entity_id || '',
          ssoUrl: idp.sso_url || '',
          sloUrl: idp.slo_url || '',
          certPem: idp.cert_pem || '',
          attributeMapping: idp.attribute_mapping?.preset || 'generic',
          allowedEmailDomains: (idp.allowed_email_domains || []).join(', '),
          jitProvisioning: !!idp.jit_provisioning,
          enabled: !!idp.enabled,
        });
        setMode('fields');
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
      .map((/** @type {any} */ d) => d.trim().toLowerCase())
      .filter(Boolean);
    if (domains.length === 0) {
      setError('At least one email domain is required.');
      setBusy(false);
      return;
    }
    /** @type {any} */
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
    <div className="modal-overlay" onClick={onClose}>
      <div className="saml-config-modal" onClick={(/** @type {any} */ e) => e.stopPropagation()}>
        <h3 className="saml-config-section-title">
          {isNew ? 'Add identity provider' : 'Edit identity provider'}
        </h3>

        <Field
          label="Display name"
          value={form.displayName}
          onChange={(/** @type {any} */ v) => setForm({ ...form, displayName: v })}
          placeholder="UCC, TCD, Acme Corp, …"
        />

        {isNew && (
          <div className="saml-config-mode-tabs">
            <button
              type="button"
              className={`admin-audit-btn ${mode === 'metadata' ? 'active' : ''}`}
              onClick={() => setMode('metadata')}
            >
              Paste metadata XML
            </button>
            <button
              type="button"
              className={`admin-audit-btn ${mode === 'fields' ? 'active' : ''}`}
              onClick={() => setMode('fields')}
            >
              Field-by-field
            </button>
          </div>
        )}

        {mode === 'metadata' && isNew ? (
          <>
            <label className="saml-config-field">
              <div className="saml-config-copy-label">Metadata XML</div>
              <textarea
                className="saml-config-textarea"
                value={form.metadataXml}
                onChange={(/** @type {any} */ e) => setForm({ ...form, metadataXml: e.target.value })}
                placeholder="<EntityDescriptor xmlns:md=…>…"
                rows={10}
              />
            </label>
            <div className="saml-config-actions">
              <button
                type="button"
                className="admin-audit-btn"
                onClick={handleTest}
                disabled={!form.metadataXml}
              >
                Test parse
              </button>
            </div>
            {testPreview && (
              <div className="saml-config-preview">
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
              onChange={(/** @type {any} */ v) => setForm({ ...form, entityId: v })}
              placeholder="https://idp.ucc.ie/idp/shibboleth"
              disabled={!isNew}
              note={!isNew ? 'Entity ID is immutable — delete and re-create the IdP if it needs to change.' : null}
            />
            <Field
              label="SSO URL"
              value={form.ssoUrl}
              onChange={(/** @type {any} */ v) => setForm({ ...form, ssoUrl: v })}
              placeholder="https://idp.ucc.ie/idp/profile/SAML2/POST/SSO"
            />
            <Field
              label="SLO URL (optional)"
              value={form.sloUrl}
              onChange={(/** @type {any} */ v) => setForm({ ...form, sloUrl: v })}
              placeholder="https://idp.ucc.ie/idp/profile/SAML2/Redirect/SLO"
            />
            <label className="saml-config-field">
              <div className="saml-config-copy-label">Certificate PEM</div>
              <textarea
                className="saml-config-textarea saml-config-textarea--cert"
                value={form.certPem}
                onChange={(/** @type {any} */ e) => setForm({ ...form, certPem: e.target.value })}
                placeholder="-----BEGIN CERTIFICATE-----…"
                rows={5}
              />
            </label>
          </>
        )}

        <label className="saml-config-field">
          <div className="saml-config-copy-label">Attribute mapping</div>
          <select
            className="saml-config-select"
            value={form.attributeMapping}
            onChange={(/** @type {any} */ e) => setForm({ ...form, attributeMapping: e.target.value })}
          >
            {PRESETS.map((/** @type {any} */ p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </label>

        <Field
          label="Allowed email domains (comma or space separated)"
          value={form.allowedEmailDomains}
          onChange={(/** @type {any} */ v) => setForm({ ...form, allowedEmailDomains: v })}
          placeholder="ucc.ie, cs.ucc.ie"
          note="Users with emails in these domains will be routed to this IdP."
        />

        <label className="saml-config-checkbox">
          <input
            type="checkbox"
            checked={form.jitProvisioning}
            onChange={(/** @type {any} */ e) => setForm({ ...form, jitProvisioning: e.target.checked })}
          />
          Just-in-time user provisioning (auto-create accounts on first login)
        </label>
        <label className="saml-config-checkbox">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(/** @type {any} */ e) => setForm({ ...form, enabled: e.target.checked })}
          />
          Enabled (visible on the login page; users can sign in via this IdP)
        </label>

        {error && (
          <div className="saml-config-error">{error}</div>
        )}

        <div className="saml-config-modal-footer">
          <button type="button" className="modal-btn modal-btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="modal-btn modal-btn-primary" onClick={handleSave} disabled={busy}>
            {busy ? 'Saving…' : (isNew ? 'Create' : 'Save')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** @param {any} props */
function Field({ label, value, onChange, placeholder, disabled, note }) {
  return (
    <label className="saml-config-field">
      <div className="saml-config-copy-label">{label}</div>
      <input
        type="text"
        className="saml-config-input"
        value={value}
        onChange={(/** @type {any} */ e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
      />
      {note && <div className="saml-config-hint">{note}</div>}
    </label>
  );
}

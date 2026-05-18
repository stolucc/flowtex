// Self-signed TLS cert + key, generated on first run, persisted to
// ~/.flowtex-helper/certs/, valid for 10 years. The browser will warn
// the first time the user hits https://localhost:9876/health directly
// — once they accept the exception, all subsequent fetches from a
// FlowTex tab work without warning (browsers cache cert acceptance
// per origin).
//
// A proper Lets-Encrypt cert for helper.localhost.flowtex.click is a
// follow-up (LOCAL_COMPILE_DESIGN.md §7.4). For Phase 1 a self-signed
// cert is good enough to validate the bridge.

package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"time"
)

const certValidYears = 10

// ensureTLSCert generates a self-signed cert + key pair if neither file
// exists. Idempotent: re-running with both files present is a no-op.
func ensureTLSCert(cfg *config) error {
	_, certErr := os.Stat(cfg.CertFile)
	_, keyErr := os.Stat(cfg.KeyFile)
	if certErr == nil && keyErr == nil {
		return nil
	}

	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return fmt.Errorf("generate key: %w", err)
	}

	serialMax := new(big.Int).Lsh(big.NewInt(1), 128)
	serial, err := rand.Int(rand.Reader, serialMax)
	if err != nil {
		return fmt.Errorf("generate serial: %w", err)
	}

	template := x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			Organization: []string{"FlowTex Local Helper"},
			CommonName:   "flowtex-helper",
		},
		NotBefore:             time.Now().Add(-1 * time.Hour),
		NotAfter:              time.Now().AddDate(certValidYears, 0, 0),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		// SANs: every loopback name the user might hit. helper.localhost…
		// is the future production hostname (Lets-Encrypt target); we
		// preinclude it so a self-signed cert covers both modes.
		DNSNames: []string{
			"localhost",
			"helper.localhost.flowtex.click",
		},
		IPAddresses: []net.IP{
			net.IPv4(127, 0, 0, 1),
			net.IPv6loopback,
		},
	}

	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &priv.PublicKey, priv)
	if err != nil {
		return fmt.Errorf("create certificate: %w", err)
	}

	if err := writePem(cfg.CertFile, "CERTIFICATE", der, 0o644); err != nil {
		return fmt.Errorf("write cert: %w", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		return fmt.Errorf("marshal key: %w", err)
	}
	if err := writePem(cfg.KeyFile, "EC PRIVATE KEY", keyDER, 0o600); err != nil {
		return fmt.Errorf("write key: %w", err)
	}
	return nil
}

func writePem(path, blockType string, der []byte, mode os.FileMode) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	defer f.Close()
	return pem.Encode(f, &pem.Block{Type: blockType, Bytes: der})
}

// certFingerprint returns the SHA-256 fingerprint of the cert at `path`,
// in `aa:bb:…` form (suitable for matching against a browsers cert UI).
func certFingerprint(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	block, _ := pem.Decode(data)
	if block == nil {
		return "", fmt.Errorf("no PEM block in %s", path)
	}
	sum := sha256.Sum256(block.Bytes)
	hexStr := hex.EncodeToString(sum[:])
	// Insert colons every two chars for readability.
	out := make([]byte, 0, len(hexStr)+len(hexStr)/2)
	for i, c := range hexStr {
		if i > 0 && i%2 == 0 {
			out = append(out, ':')
		}
		out = append(out, byte(c))
	}
	return string(out), nil
}

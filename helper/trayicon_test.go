//go:build darwin || windows

// Structural test for the tray-icon bytes — pins the ICO header
// fields. Without this, a future tweak that miscomputes the
// pixel-data length or forgets the doubled-height in the
// BITMAPINFOHEADER would ship a corrupt file and the helper
// would render a blank tray slot.

package main

import (
	"encoding/binary"
	"testing"
)

func TestTrayIconBytes_IsValidIcoStructure(t *testing.T) {
	b := trayIconBytes()
	if len(b) < 22 {
		t.Fatalf("icon shorter than ICONDIR+ICONDIRENTRY (22 bytes); got %d", len(b))
	}

	// ICONDIR header: reserved(2)=0, type(2)=1, count(2)=1
	if r := binary.LittleEndian.Uint16(b[0:2]); r != 0 {
		t.Errorf("ICONDIR.reserved = %d, want 0", r)
	}
	if ty := binary.LittleEndian.Uint16(b[2:4]); ty != 1 {
		t.Errorf("ICONDIR.type = %d, want 1 (icon)", ty)
	}
	if c := binary.LittleEndian.Uint16(b[4:6]); c != 1 {
		t.Errorf("ICONDIR.count = %d, want 1", c)
	}

	// ICONDIRENTRY[0]: width(1), height(1), colorCount(1), reserved(1),
	// planes(2), bitCount(2), bytesInRes(4), imageOffset(4).
	width := b[6]
	height := b[7]
	if width != 16 || height != 16 {
		t.Errorf("entry size = %dx%d, want 16x16", width, height)
	}
	if bpp := binary.LittleEndian.Uint16(b[12:14]); bpp != 32 {
		t.Errorf("entry bpp = %d, want 32", bpp)
	}
	bytesInRes := binary.LittleEndian.Uint32(b[14:18])
	offset := binary.LittleEndian.Uint32(b[18:22])
	if offset != 22 {
		t.Errorf("entry offset = %d, want 22 (ICONDIR + ICONDIRENTRY)", offset)
	}
	if int(offset+bytesInRes) != len(b) {
		t.Errorf("entry says image is %d bytes at offset %d, total %d, file is %d",
			bytesInRes, offset, offset+bytesInRes, len(b))
	}

	// BITMAPINFOHEADER inside the image data: size(4)=40, width(4),
	// height(4) is DOUBLED (XOR + AND masks both stored under one
	// header — this is the ICO format's specific quirk).
	if hdr := binary.LittleEndian.Uint32(b[22:26]); hdr != 40 {
		t.Errorf("BITMAPINFOHEADER.size = %d, want 40", hdr)
	}
	if w := int32(binary.LittleEndian.Uint32(b[26:30])); w != 16 {
		t.Errorf("BITMAPINFOHEADER.width = %d, want 16", w)
	}
	// height = h*2 = 32
	if h := int32(binary.LittleEndian.Uint32(b[30:34])); h != 32 {
		t.Errorf("BITMAPINFOHEADER.height = %d, want 32 (doubled for AND mask)", h)
	}

	// Spot-check the pixel data is non-empty + non-uniform. A blank
	// or all-one-colour buffer would build a corrupt-looking tray
	// icon; we paint a white "F" on blue so adjacent pixels should
	// have observably different colours somewhere.
	pixels := b[62 : 62+1024]
	first4 := pixels[0:4]
	var diff bool
	for i := 4; i < len(pixels); i += 4 {
		if pixels[i] != first4[0] || pixels[i+1] != first4[1] || pixels[i+2] != first4[2] {
			diff = true
			break
		}
	}
	if !diff {
		t.Error("pixel buffer is uniform colour — the 'F' glyph isn't being drawn")
	}
}

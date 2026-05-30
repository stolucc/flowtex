//go:build darwin || windows

// Tray-icon bytes for the OSes where systray actually renders an
// icon. macOS' menu bar shows the SetTitle text fine; Windows' tray
// only renders icons, so the previous text-only "fTx" produced a
// generic fallback that was hard to identify.
//
// Strategy: generate a small .ico programmatically at startup
// rather than committing a binary file. Keeps the repo text-only
// and means the icon's appearance can be tuned by editing one Go
// function. macOS receives the same bytes — systray on macOS
// accepts ICO format too, so a single asset covers both.

package main

import (
	"bytes"
	"encoding/binary"
)

// trayIconBytes returns a 16x16 32-bit BMP-format Windows .ico
// containing the FlowTex helper glyph: a blue square with a white
// "F". Structure (per the Microsoft ICO spec):
//
//	  6 B  ICONDIR             (reserved | type | count)
//	 16 B  ICONDIRENTRY x 1    (size + offset to image data)
//	 40 B  BITMAPINFOHEADER    (note: height field is doubled — XOR + AND masks)
//	1024 B XOR pixel data       (16 × 16 × 4 BGRA, bottom-up)
//	  32 B AND mask             (16 × 16 / 8 = 32, bottom-up, opaque everywhere)
//
// Total: 1118 bytes. Embedded in every build (negligible size cost).
func trayIconBytes() []byte {
	// All sizes derive from the 16x16 dimensions and are compile-time
	// constants, so binary.Write gets correctly-typed values and the
	// linter doesn't flag int→uint32 conversions (gosec G115).
	const (
		w, h          = 16, 16
		pixelBytes    uint32 = w * h * 4         // 1024 — 32bpp BGRA
		andMaskBytes  uint32 = (w / 8) * h       // 32   — 1bpp opacity mask
		bmpHeaderSize uint32 = 40
		dataSize      uint32 = bmpHeaderSize + pixelBytes + andMaskBytes
		entryOffset   uint32 = 6 + 16            // ICONDIR + one ICONDIRENTRY
	)
	pixels := buildTrayPixels(w, h)
	andMask := make([]byte, andMaskBytes) // all zeros = fully opaque

	var buf bytes.Buffer
	// ICONDIR
	_ = binary.Write(&buf, binary.LittleEndian, uint16(0)) // reserved
	_ = binary.Write(&buf, binary.LittleEndian, uint16(1)) // type: 1 = icon
	_ = binary.Write(&buf, binary.LittleEndian, uint16(1)) // count

	// ICONDIRENTRY
	buf.WriteByte(byte(w))
	buf.WriteByte(byte(h))
	buf.WriteByte(0) // color count: 0 for 32bpp
	buf.WriteByte(0) // reserved
	_ = binary.Write(&buf, binary.LittleEndian, uint16(1))  // planes
	_ = binary.Write(&buf, binary.LittleEndian, uint16(32)) // bpp
	_ = binary.Write(&buf, binary.LittleEndian, dataSize)
	_ = binary.Write(&buf, binary.LittleEndian, entryOffset)

	// BITMAPINFOHEADER (note: height is doubled to cover the XOR + AND masks)
	_ = binary.Write(&buf, binary.LittleEndian, bmpHeaderSize) // header size
	_ = binary.Write(&buf, binary.LittleEndian, int32(w))      // width
	_ = binary.Write(&buf, binary.LittleEndian, int32(h*2))    // height (XOR + AND)
	_ = binary.Write(&buf, binary.LittleEndian, uint16(1))     // planes
	_ = binary.Write(&buf, binary.LittleEndian, uint16(32))    // bpp
	_ = binary.Write(&buf, binary.LittleEndian, uint32(0))     // compression (BI_RGB)
	_ = binary.Write(&buf, binary.LittleEndian, pixelBytes)
	_ = binary.Write(&buf, binary.LittleEndian, int32(0)) // x ppm
	_ = binary.Write(&buf, binary.LittleEndian, int32(0)) // y ppm
	_ = binary.Write(&buf, binary.LittleEndian, uint32(0))
	_ = binary.Write(&buf, binary.LittleEndian, uint32(0))

	buf.Write(pixels)
	buf.Write(andMask)
	return buf.Bytes()
}

// buildTrayPixels paints a 16x16 BGRA buffer in BOTTOM-UP order (BMP
// convention). Background is FlowTex blue; foreground is a stylised
// white "F" centred in the canvas.
func buildTrayPixels(w, h int) []byte {
	// FlowTex accent blue. Picked to match the in-app accent so the
	// tray icon visually ties back to the editor UI.
	const bgR, bgG, bgB = 0x42, 0x80, 0xE6
	const fgR, fgG, fgB = 0xFF, 0xFF, 0xFF

	// Lay out the canvas in normal top-down (y=0 at top) order, then
	// flip when writing — simpler than reasoning about bottom-up in
	// the drawing code.
	canvas := make([][3]byte, w*h)
	for i := range canvas {
		canvas[i] = [3]byte{bgR, bgG, bgB}
	}
	set := func(x, y int) {
		if x < 0 || x >= w || y < 0 || y >= h {
			return
		}
		canvas[y*w+x] = [3]byte{fgR, fgG, fgB}
	}

	// "F" — 5 wide × 9 tall, positioned at x=5, y=4 (eyeballed to
	// centre in 16x16 with one pixel of breathing room each side).
	// Top bar
	for x := 5; x <= 10; x++ {
		set(x, 4)
	}
	// Middle bar
	for x := 5; x <= 9; x++ {
		set(x, 8)
	}
	// Vertical stem
	for y := 4; y <= 12; y++ {
		set(5, y)
	}

	// Flip to bottom-up BGRA.
	out := make([]byte, w*h*4)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			c := canvas[y*w+x]
			dst := ((h-1-y)*w + x) * 4
			out[dst+0] = c[2] // B
			out[dst+1] = c[1] // G
			out[dst+2] = c[0] // R
			out[dst+3] = 0xFF // A (opaque)
		}
	}
	return out
}

//! Keep an attached image inside the API's many-image ceiling.
//!
//! WHY THE HUB. Once a request carries several images, Anthropic refuses the
//! WHOLE request if any one of them is over 2000px on a side: «At least one of
//! the image dimensions exceed max allowed size for many-image requests: 2000
//! pixels». A phone screenshot is 1179×2556. So a session where someone pastes
//! a couple of those starts answering every turn with an API error instead of a
//! turn — and nothing on screen connects the two.
//!
//! The web composer shrinks before sending (`fileToImageInput` in web/src/lib.ts),
//! which covers the browser. It does not cover the iOS app, the Telegram bot, or
//! whatever is written next. The hub is the one place every client passes
//! through, so the ceiling belongs here too — belt for their braces.
//!
//! WHAT IT DOES NOT FIX: images already written into a transcript. The runtime
//! resends its own history, and rewriting a live `.jsonl` to edit them would
//! break the single-writer invariant this whole product is built around. A
//! session poisoned before this shipped is cured by compaction, not by us.
//!
//! COST. This runs on the hub's message loop, so it must not decode by reflex:
//! dimensions come from the file HEADER first (a few dozen bytes), and the
//! decode-resize-encode path is entered only for an image that is actually over
//! the line. Measured on the hub box, a 3MB screenshot costs ~0.6s — rare enough
//! to accept, frequent enough that doing it unconditionally would not be.

use std::io::Cursor;

use base64::Engine;
use image::imageops::FilterType;

/// Longest side an image may keep. 1568 and not 2000: it is what the API
/// downscales to for its own accounting anyway, so pixels above it cost bytes
/// and tokens and buy no detail.
pub const MAX_EDGE: u32 = 1568;

/// Read width/height WITHOUT decoding the pixels. Returns `None` for a format
/// we do not parse (then the image is passed through untouched — refusing to
/// understand something is not a reason to drop it).
fn probe(bytes: &[u8]) -> Option<(u32, u32)> {
    // PNG: 8-byte signature, then an IHDR chunk whose first 8 bytes are w/h.
    if bytes.len() > 24 && bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        let w = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
        let h = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
        return Some((w, h));
    }
    // JPEG: walk the segment chain to the first SOFn (which is where the size
    // lives); EXIF and huge thumbnails sit before it, so a fixed offset lies.
    if bytes.len() > 4 && bytes[0] == 0xFF && bytes[1] == 0xD8 {
        let mut i = 2usize;
        while i + 9 < bytes.len() {
            if bytes[i] != 0xFF {
                i += 1;
                continue;
            }
            let marker = bytes[i + 1];
            // SOF0..SOF15, minus the four that are not frame headers.
            if (0xC0..=0xCF).contains(&marker) && marker != 0xC4 && marker != 0xC8 && marker != 0xCC
            {
                let h = u16::from_be_bytes([bytes[i + 5], bytes[i + 6]]) as u32;
                let w = u16::from_be_bytes([bytes[i + 7], bytes[i + 8]]) as u32;
                return Some((w, h));
            }
            let len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
            if len < 2 {
                return None;
            }
            i += 2 + len;
        }
        return None;
    }
    None
}

/// The image, shrunk to `MAX_EDGE` — or `None` when it already fits, cannot be
/// read here, or is a format we refuse to re-encode.
///
/// GIF is deliberately left alone: re-encoding drops the animation, and a
/// moving picture turned into a still is a worse answer than a large one.
pub fn shrink(media_type: &str, b64: &str) -> Option<(String, String)> {
    if media_type == "image/gif" {
        return None;
    }
    let engine = base64::engine::general_purpose::STANDARD;
    let bytes = engine.decode(b64).ok()?;
    // Cheap first: most images are already small, and they must cost nothing.
    if let Some((w, h)) = probe(&bytes) {
        if w.max(h) <= MAX_EDGE {
            return None;
        }
    }
    let img = image::load_from_memory(&bytes).ok()?;
    let (w, h) = (img.width(), img.height());
    if w.max(h) <= MAX_EDGE {
        return None;
    }
    let scale = MAX_EDGE as f32 / w.max(h) as f32;
    let (nw, nh) = (
        ((w as f32 * scale).round() as u32).max(1),
        ((h as f32 * scale).round() as u32).max(1),
    );
    // Triangle, not Lanczos3: this is a readability pass on a box whose CPU we
    // have measured and found slow, and the difference at a 2x reduction is not
    // visible in a screenshot of text.
    let resized = img.resize_exact(nw, nh, FilterType::Triangle);
    let mut out = Vec::new();
    // PNG out for everything we touch. A screenshot of text re-encoded to JPEG
    // rings exactly on the letters, which is the part being asked about.
    resized
        .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
        .ok()?;
    eprintln!(
        "[images] {w}x{h} -> {nw}x{nh} ({} -> {} B)",
        bytes.len(),
        out.len()
    );
    Some(("image/png".to_string(), engine.encode(out)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(w: u32, h: u32) -> String {
        let img = image::RgbImage::new(w, h);
        let mut out = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        base64::engine::general_purpose::STANDARD.encode(out)
    }

    #[test]
    fn reads_png_size_without_decoding() {
        let data = base64::engine::general_purpose::STANDARD
            .decode(png(1179, 2556))
            .unwrap();
        assert_eq!(probe(&data), Some((1179, 2556)));
    }

    #[test]
    fn an_image_that_fits_is_left_alone() {
        // Identity matters more than it looks: re-encoding every attachment
        // would quietly change bytes, sizes and media types for no reason.
        assert!(shrink("image/png", &png(800, 600)).is_none());
    }

    #[test]
    fn a_phone_screenshot_comes_back_under_the_ceiling() {
        let (mt, data) = shrink("image/png", &png(1179, 2556)).expect("must shrink");
        assert_eq!(mt, "image/png");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&data)
            .unwrap();
        let (w, h) = probe(&bytes).expect("still a png");
        assert!(w.max(h) <= MAX_EDGE, "{w}x{h} is still over the ceiling");
        // Aspect ratio survives: 1179/2556 ≈ 0.461.
        let ratio = w as f32 / h as f32;
        assert!(
            (ratio - 1179.0 / 2556.0).abs() < 0.01,
            "ratio drifted to {ratio}"
        );
    }

    #[test]
    fn an_animated_gif_is_never_re_encoded() {
        assert!(shrink("image/gif", &png(4000, 4000)).is_none());
    }
}

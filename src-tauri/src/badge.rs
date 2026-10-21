//! Live tray icons: the app icon with a coloured status dot, or a tile showing
//! the current streak. Plain RGBA pixel work, so it's easy to unit test.

/// Tray icons are rendered at 32×32 (the tray size at 200% scaling); Windows
/// scales them down for lower DPIs.
pub const SIZE: u32 = 32;

/// How today is going, as shown by the tray icon.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DayStatus {
    /// Contributed today.
    Done,
    /// Nothing yet, but there's still time.
    Pending,
    /// Nothing yet, it's past the reminder hour and a streak is on the line.
    AtRisk,
}

impl DayStatus {
    pub fn from_counts(today_count: i32, streak: u32, hour: u32, reminder_hour: u8) -> Self {
        if today_count > 0 {
            DayStatus::Done
        } else if streak > 0 && hour >= reminder_hour as u32 {
            DayStatus::AtRisk
        } else {
            DayStatus::Pending
        }
    }

    /// Tooltip line describing the status.
    pub fn label(self) -> &'static str {
        match self {
            DayStatus::Done => "✅ Done for today",
            DayStatus::Pending => "⏳ No contributions yet today",
            DayStatus::AtRisk => "⚠️ Streak at risk — contribute before midnight",
        }
    }

    fn color(self) -> [u8; 3] {
        match self {
            DayStatus::Done => [0x2e, 0xa0, 0x43],
            DayStatus::Pending => [0xc6, 0x90, 0x26],
            DayStatus::AtRisk => [0xe5, 0x53, 0x4b],
        }
    }
}

const RING: [u8; 3] = [0x0d, 0x11, 0x17];
const WHITE: [u8; 3] = [0xff, 0xff, 0xff];

/// 3×5 pixel digits, one row per byte (bit 2 = left column).
const DIGITS: [[u8; 5]; 10] = [
    [0b111, 0b101, 0b101, 0b101, 0b111],
    [0b010, 0b110, 0b010, 0b010, 0b111],
    [0b111, 0b001, 0b111, 0b100, 0b111],
    [0b111, 0b001, 0b111, 0b001, 0b111],
    [0b101, 0b101, 0b111, 0b001, 0b001],
    [0b111, 0b100, 0b111, 0b001, 0b111],
    [0b111, 0b100, 0b111, 0b101, 0b111],
    [0b111, 0b001, 0b001, 0b001, 0b001],
    [0b111, 0b101, 0b111, 0b101, 0b111],
    [0b111, 0b101, 0b111, 0b001, 0b111],
];

/// Source-over blend of `color` at `alpha` (0..1) onto an RGBA pixel.
fn blend(px: &mut [u8], color: [u8; 3], alpha: f32) {
    if alpha <= 0.0 {
        return;
    }
    let sa = alpha.min(1.0);
    let da = px[3] as f32 / 255.0;
    let oa = sa + da * (1.0 - sa);
    for c in 0..3 {
        px[c] = ((color[c] as f32 * sa + px[c] as f32 * da * (1.0 - sa)) / oa).round() as u8;
    }
    px[3] = (oa * 255.0).round() as u8;
}

fn pixel(buf: &mut [u8], x: u32, y: u32) -> &mut [u8] {
    let i = ((y * SIZE + x) * 4) as usize;
    &mut buf[i..i + 4]
}

/// Box-filters any RGBA image down (or up) to SIZE×SIZE. Colour is averaged
/// weighted by alpha so transparent edges don't darken.
fn resize(src: &[u8], width: u32, height: u32) -> Vec<u8> {
    let n = SIZE as usize;
    let mut out = vec![0u8; n * n * 4];
    let (w, h) = (width as usize, height as usize);
    if w == 0 || h == 0 || src.len() < w * h * 4 {
        return out;
    }
    for ty in 0..n {
        let y0 = ty * h / n;
        let y1 = ((ty + 1) * h / n).max(y0 + 1);
        for tx in 0..n {
            let x0 = tx * w / n;
            let x1 = ((tx + 1) * w / n).max(x0 + 1);
            let mut sum = [0u64; 4];
            let mut count = 0u64;
            for y in y0..y1 {
                for x in x0..x1 {
                    let i = (y * w + x) * 4;
                    let a = src[i + 3] as u64;
                    for c in 0..3 {
                        sum[c] += src[i + c] as u64 * a;
                    }
                    sum[3] += a;
                    count += 1;
                }
            }
            let o = (ty * n + tx) * 4;
            if sum[3] > 0 {
                for c in 0..3 {
                    out[o + c] = (sum[c] / sum[3]) as u8;
                }
            }
            out[o + 3] = (sum[3] / count) as u8;
        }
    }
    out
}

/// Anti-aliased filled circle.
fn circle(buf: &mut [u8], cx: f32, cy: f32, radius: f32, color: [u8; 3]) {
    for y in 0..SIZE {
        for x in 0..SIZE {
            let d = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
            blend(pixel(buf, x, y), color, radius + 0.5 - d);
        }
    }
}

/// The app icon scaled to SIZE with a status dot in the bottom-right corner.
pub fn with_status_dot(rgba: &[u8], width: u32, height: u32, status: DayStatus) -> Vec<u8> {
    let mut buf = resize(rgba, width, height);
    let c = SIZE as f32 - 8.5;
    circle(&mut buf, c, c, 8.5, RING);
    circle(&mut buf, c, c, 6.5, status.color());
    buf
}

/// A rounded tile in the status colour with the streak number on it.
pub fn streak_tile(streak: u32, status: DayStatus) -> Vec<u8> {
    let mut buf = vec![0u8; (SIZE * SIZE * 4) as usize];
    let half = SIZE as f32 / 2.0;
    let radius = 7.0;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = ((x as f32 + 0.5 - half).abs() - (half - radius)).max(0.0);
            let dy = ((y as f32 + 0.5 - half).abs() - (half - radius)).max(0.0);
            let d = (dx * dx + dy * dy).sqrt() - radius;
            blend(pixel(&mut buf, x, y), status.color(), 0.5 - d);
        }
    }

    let digits: Vec<usize> = streak.to_string().bytes().map(|b| (b - b'0') as usize).collect();
    let n = digits.len() as u32;
    // Largest scale at which the number still fits inside the tile.
    let scale = (1..=4u32).rev().find(|&s| n * 3 * s + (n - 1) * s <= 28 && 5 * s <= 20).unwrap_or(1);
    let text_w = n * 3 * scale + (n - 1) * scale;
    let (x0, y0) = ((SIZE - text_w.min(SIZE)) / 2, (SIZE - 5 * scale) / 2);
    for (i, &digit) in digits.iter().enumerate() {
        let left = x0 + i as u32 * 4 * scale;
        for (row, bits) in DIGITS[digit].iter().enumerate() {
            for col in 0..3u32 {
                if bits & (0b100 >> col) == 0 {
                    continue;
                }
                for sy in 0..scale {
                    for sx in 0..scale {
                        let (x, y) = (left + col * scale + sx, y0 + row as u32 * scale + sy);
                        if x < SIZE && y < SIZE {
                            blend(pixel(&mut buf, x, y), WHITE, 1.0);
                        }
                    }
                }
            }
        }
    }
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(buf: &[u8], x: u32, y: u32) -> [u8; 4] {
        let i = ((y * SIZE + x) * 4) as usize;
        [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]
    }

    #[test]
    fn status_follows_today_and_reminder_hour() {
        assert_eq!(DayStatus::from_counts(3, 10, 23, 20), DayStatus::Done);
        assert_eq!(DayStatus::from_counts(0, 10, 19, 20), DayStatus::Pending);
        assert_eq!(DayStatus::from_counts(0, 10, 20, 20), DayStatus::AtRisk);
        // No streak to lose → just pending, even late.
        assert_eq!(DayStatus::from_counts(0, 0, 23, 20), DayStatus::Pending);
    }

    #[test]
    fn dot_is_drawn_over_a_scaled_icon() {
        let src = vec![255u8; 64 * 64 * 4]; // opaque white 64×64
        let buf = with_status_dot(&src, 64, 64, DayStatus::AtRisk);
        assert_eq!(buf.len(), (SIZE * SIZE * 4) as usize);
        assert_eq!(at(&buf, 2, 2), [255, 255, 255, 255]);
        let [r, g, b, a] = at(&buf, 23, 23);
        assert_eq!([r, g, b, a], [0xe5, 0x53, 0x4b, 255]);
    }

    #[test]
    fn bad_icon_data_falls_back_to_transparent() {
        let buf = with_status_dot(&[1, 2, 3], 64, 64, DayStatus::Done);
        assert_eq!(at(&buf, 2, 2)[3], 0);
    }

    #[test]
    fn streak_tile_has_transparent_corners_and_white_digits() {
        let buf = streak_tile(7, DayStatus::Done);
        assert_eq!(at(&buf, 0, 0)[3], 0);
        assert_eq!(at(&buf, 16, 2), [0x2e, 0xa0, 0x43, 255]);
        // "7" at scale 4: top bar spans the glyph's full width.
        assert_eq!(at(&buf, 11, 7), [255, 255, 255, 255]);
        // Long streaks still render inside the tile.
        assert_eq!(streak_tile(1234, DayStatus::Pending).len(), (SIZE * SIZE * 4) as usize);
    }
}

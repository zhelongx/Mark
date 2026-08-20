using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Windows.Forms;

// Takes the official Chromium cursor bitmaps as the geometry source.  This
// deliberately changes colour only: alpha, outline placement, hotspots and
// all hand contours stay inherited from Chromium's grab/grabbing cursors.
internal static class TintChromiumGrabCursor
{
    private static Color Tint(Color source)
    {
        if (source.A == 0) return source;
        var light = (source.R * 0.2126f + source.G * 0.7152f + source.B * 0.0722f) / 255f;
        // Preserve the familiar dark Chromium outline but move it into Draw's
        // espresso ink; lighten the original cursor body into warm paper.
        var low = Color.FromArgb(source.A, 75, 56, 42);
        var high = Color.FromArgb(source.A, 255, 247, 231);
        var t = Math.Max(0, Math.Min(1, (light - .08f) / .86f));
        return Color.FromArgb(source.A,
            (int)Math.Round(low.R + (high.R - low.R) * t),
            (int)Math.Round(low.G + (high.G - low.G) * t),
            (int)Math.Round(low.B + (high.B - low.B) * t));
    }

    private static Bitmap RenderAndTint(string cursorPath)
    {
        // Chromium's source cursor is deliberately 32px; keep its native
        // raster size so no resampling changes the original pixel geometry.
        var bitmap = new Bitmap(32, 32, PixelFormat.Format32bppArgb);
        using (var cursor = new Cursor(cursorPath))
        using (var g = Graphics.FromImage(bitmap))
        {
            g.Clear(Color.Transparent);
            cursor.Draw(g, new Rectangle(0, 0, 32, 32));
        }
        for (var y = 0; y < bitmap.Height; y++)
        for (var x = 0; x < bitmap.Width; x++) bitmap.SetPixel(x, y, Tint(bitmap.GetPixel(x, y)));
        return bitmap;
    }

    private static void Preview(Graphics g, Bitmap open, Bitmap closed)
    {
        g.Clear(Color.FromArgb(255, 243, 233, 213));
        using (var top = new SolidBrush(Color.FromArgb(255, 35, 33, 31))) g.FillRectangle(top, 0, 0, 800, 130);
        using (var separator = new Pen(Color.FromArgb(255, 188, 158, 117), 2)) g.DrawLine(separator, 400, 0, 400, 430);
        using (var heading = new Font("Microsoft YaHei UI", 19, FontStyle.Bold))
        using (var label = new Font("Microsoft YaHei UI", 15))
        using (var pale = new SolidBrush(Color.FromArgb(255, 250, 241, 223)))
        using (var ink = new SolidBrush(Color.FromArgb(255, 87, 64, 48)))
        {
            g.DrawString("Chromium grab · 悬停", heading, pale, 72, 45);
            g.DrawString("Chromium grabbing · 拖动", heading, pale, 440, 45);
            g.DrawString("实际 32px", label, ink, 54, 175);
            g.DrawString("实际 32px", label, ink, 454, 175);
        }
        g.DrawImage(open, new Rectangle(150, 164, 64, 64));
        g.DrawImage(closed, new Rectangle(550, 164, 64, 64));
        g.InterpolationMode = InterpolationMode.NearestNeighbor;
        g.PixelOffsetMode = PixelOffsetMode.Half;
        g.DrawImage(open, new Rectangle(70, 245, 250, 250));
        g.DrawImage(closed, new Rectangle(470, 245, 250, 250));
    }

    public static void Main(string[] args)
    {
        if (args.Length != 2) throw new ArgumentException("Expected source and output directories.");
        var source = args[0];
        var output = args[1];
        Directory.CreateDirectory(output);
        using (var open = RenderAndTint(Path.Combine(source, "hand_grab.cur")))
        using (var closed = RenderAndTint(Path.Combine(source, "hand_grabbing.cur")))
        {
            open.Save(Path.Combine(output, "chromium-hand-grab-beige.png"), ImageFormat.Png);
            closed.Save(Path.Combine(output, "chromium-hand-grabbing-beige.png"), ImageFormat.Png);
            using (var review = new Bitmap(800, 530, PixelFormat.Format32bppArgb))
            using (var g = Graphics.FromImage(review))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
                Preview(g, open, closed);
                review.Save(Path.Combine(output, "chromium-beige-review.png"), ImageFormat.Png);
            }
        }
    }
}

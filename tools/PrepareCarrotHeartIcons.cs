using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;

// Prepares the accepted activity-state art for the small toolbar hit target.
// Material input already has an alpha channel. The flat source was supplied
// on a neutral generator checkerboard, so very-light neutral squares are
// removed before the icon is fitted to its usual transparent canvas.
internal static class PrepareCarrotHeartIcons
{
    private static Rectangle OpaqueBounds(Bitmap image)
    {
        var left = image.Width;
        var top = image.Height;
        var right = -1;
        var bottom = -1;
        for (var y = 0; y < image.Height; y++)
        for (var x = 0; x < image.Width; x++)
        {
            if (image.GetPixel(x, y).A <= 4) continue;
            left = Math.Min(left, x); top = Math.Min(top, y);
            right = Math.Max(right, x); bottom = Math.Max(bottom, y);
        }
        if (right < left || bottom < top) throw new InvalidOperationException("The source has no visible artwork.");
        return Rectangle.FromLTRB(left, top, right + 1, bottom + 1);
    }

    private static bool IsGeneratorChecker(Color color)
    {
        return color.R >= 228 && color.G >= 228 && color.B >= 228
            && Math.Abs(color.R - color.G) <= 7 && Math.Abs(color.G - color.B) <= 7;
    }

    private static void Prepare(string inputPath, string outputPath, Size canvas, bool removeChecker)
    {
        using (var source = new Bitmap(inputPath))
        using (var artwork = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppArgb))
        {
            for (var y = 0; y < source.Height; y++)
            for (var x = 0; x < source.Width; x++)
            {
                var pixel = source.GetPixel(x, y);
                artwork.SetPixel(x, y, removeChecker && IsGeneratorChecker(pixel)
                    ? Color.FromArgb(0, pixel.R, pixel.G, pixel.B)
                    : pixel);
            }

            var bounds = OpaqueBounds(artwork);
            const int inset = 7;
            var scale = Math.Min((canvas.Width - inset * 2f) / bounds.Width, (canvas.Height - inset * 2f) / bounds.Height);
            var drawWidth = Math.Max(1, (int)Math.Round(bounds.Width * scale));
            var drawHeight = Math.Max(1, (int)Math.Round(bounds.Height * scale));
            var drawX = (canvas.Width - drawWidth) / 2;
            var drawY = (canvas.Height - drawHeight) / 2;

            using (var output = new Bitmap(canvas.Width, canvas.Height, PixelFormat.Format32bppArgb))
            using (var graphics = Graphics.FromImage(output))
            {
                graphics.Clear(Color.Transparent);
                graphics.SmoothingMode = SmoothingMode.HighQuality;
                graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                graphics.CompositingQuality = CompositingQuality.HighQuality;
                graphics.DrawImage(artwork, new Rectangle(drawX, drawY, drawWidth, drawHeight), bounds, GraphicsUnit.Pixel);
                output.Save(outputPath, ImageFormat.Png);
            }
        }
    }

    public static void Main(string[] args)
    {
        if (args.Length != 4) throw new ArgumentException("Expected material input/output and flat input/output paths.");
        Prepare(args[0], args[1], new Size(256, 320), false);
        Prepare(args[2], args[3], new Size(256, 256), true);
    }
}

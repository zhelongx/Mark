using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;

// Turns the accepted transparent paper-stack artwork into the 256px material
// toolbar asset. The ruled lines are deliberately authored at final-icon
// weight, rather than trusting a generator's hairlines to survive 33px use.
internal static class PrepareMaterialTextPaperIcon
{
    private static Rectangle AlphaBounds(Bitmap image)
    {
        var left = image.Width; var top = image.Height; var right = -1; var bottom = -1;
        for (var y = 0; y < image.Height; y++)
        for (var x = 0; x < image.Width; x++)
        {
            if (image.GetPixel(x, y).A <= 4) continue;
            left = Math.Min(left, x); top = Math.Min(top, y);
            right = Math.Max(right, x); bottom = Math.Max(bottom, y);
        }
        if (right < left || bottom < top) throw new InvalidOperationException("The source has no alpha artwork.");
        const int padding = 36;
        left = Math.Max(0, left - padding); top = Math.Max(0, top - padding);
        right = Math.Min(image.Width - 1, right + padding); bottom = Math.Min(image.Height - 1, bottom + padding);
        return Rectangle.FromLTRB(left, top, right + 1, bottom + 1);
    }

    private static void Rule(Graphics graphics, float x1, float y1, float x2, float y2)
    {
        using (var pen = new Pen(Color.FromArgb(132, 117, 82, 56), 21f))
        {
            pen.StartCap = LineCap.Round;
            pen.EndCap = LineCap.Round;
            graphics.DrawLine(pen, x1, y1, x2, y2);
        }
    }

    public static void Main(string[] args)
    {
        if (args.Length != 2) throw new ArgumentException("Expected source transparent PNG and output PNG paths.");
        using (var source = new Bitmap(args[0]))
        using (var prepared = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppArgb))
        using (var graphics = Graphics.FromImage(prepared))
        {
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.CompositingMode = CompositingMode.SourceOver;
            graphics.DrawImageUnscaled(source, 0, 0);

            // Five page rules, split around the glyph so they read as paper
            // structure rather than crossing the T at compact toolbar scale.
            Rule(graphics, 357, 232, 1005, 312);
            Rule(graphics, 332, 358, 438, 371); Rule(graphics, 894, 429, 995, 443);
            Rule(graphics, 307, 502, 562, 534); Rule(graphics, 716, 551, 970, 584);
            Rule(graphics, 271, 642, 534, 678); Rule(graphics, 694, 700, 943, 731);
            Rule(graphics, 251, 786, 472, 815); Rule(graphics, 738, 850, 913, 873);

            var sourceBounds = AlphaBounds(prepared);
            using (var output = new Bitmap(256, 256, PixelFormat.Format32bppArgb))
            using (var destination = Graphics.FromImage(output))
            {
                destination.Clear(Color.Transparent);
                destination.SmoothingMode = SmoothingMode.HighQuality;
                destination.InterpolationMode = InterpolationMode.HighQualityBicubic;
                destination.PixelOffsetMode = PixelOffsetMode.HighQuality;
                destination.CompositingQuality = CompositingQuality.HighQuality;
                const int inset = 14;
                destination.DrawImage(prepared, new Rectangle(inset, inset, 256 - inset * 2, 256 - inset * 2), sourceBounds, GraphicsUnit.Pixel);
                output.Save(args[1], ImageFormat.Png);
            }
        }
    }
}

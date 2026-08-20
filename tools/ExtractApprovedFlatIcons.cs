using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

// Production extractor for the user-approved colourful Node-style icon board.
// It preserves the approved raster pixels, removes only the connected white
// artboard, then normalizes the seven tool glyphs onto transparent 256px PNGs.
// The purple carrot is deliberately excluded: Mark retains its original
// skeuomorphic carrot in both UI styles.
internal static class ExtractApprovedFlatIcons
{
    private const int OutputSize = 256;
    // The flat set deliberately reads one optical step quieter than the
    // skeuomorphic icons in the same compact rack.
    private const int GlyphSize = 200;

    private sealed class SourceIcon
    {
        public readonly string Name;
        public readonly Rectangle Crop;
        public readonly float RotationDegrees;
        public readonly bool TwoToneCamera;
        public SourceIcon(string name, Rectangle crop, float rotationDegrees = 0, bool twoToneCamera = false) { Name = name; Crop = crop; RotationDegrees = rotationDegrees; TwoToneCamera = twoToneCamera; }
    }

    private static readonly SourceIcon[] Icons =
    {
        new SourceIcon("pencil-flat.png", new Rectangle(110, 55, 410, 370)),
        // Pencil is the reference axis: every hand tool leans at the same
        // left-down angle so the rack reads as one coherent tool family.
        new SourceIcon("eraser-flat.png", new Rectangle(500, 60, 390, 365), -7),
        new SourceIcon("highlighter-flat.png", new Rectangle(885, 55, 450, 365), -12),
        new SourceIcon("clear-flat.png", new Rectangle(1360, 55, 350, 375)),
        new SourceIcon("camera-flat.png", new Rectangle(250, 440, 440, 355), 0, true),
        new SourceIcon("palette-flat.png", new Rectangle(675, 435, 455, 375)),
        new SourceIcon("gear-flat.png", new Rectangle(1145, 435, 390, 375))
    };

    private static int Main(string[] args)
    {
        var source = args.Length > 0 ? args[0] : Path.Combine("assets", "icon-references", "flat-toolbar-approved-r1.png");
        var destination = args.Length > 1 ? args[1] : Path.Combine("assets", "icons", "flat");
        if (!File.Exists(source)) throw new FileNotFoundException("Approved icon board is missing.", source);
        Directory.CreateDirectory(destination);
        using (var board = new Bitmap(source))
        {
            foreach (var icon in Icons) SaveIcon(board, icon, Path.Combine(destination, icon.Name));
        }
        return 0;
    }

    private static void SaveIcon(Bitmap board, SourceIcon definition, string target)
    {
        using (var crop = board.Clone(definition.Crop, PixelFormat.Format32bppArgb))
        using (var foreground = RemoveConnectedArtboard(crop))
        using (var output = new Bitmap(OutputSize, OutputSize, PixelFormat.Format32bppArgb))
        using (var graphics = Graphics.FromImage(output))
        {
            if (definition.TwoToneCamera) MakeTwoToneCamera(foreground);
            graphics.Clear(Color.Transparent);
            graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
            graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
            graphics.SmoothingMode = SmoothingMode.HighQuality;
            graphics.CompositingQuality = CompositingQuality.HighQuality;
            var sourceBounds = ContentBounds(foreground);
            if (sourceBounds.Width < 1 || sourceBounds.Height < 1) throw new InvalidDataException("No icon pixels found for " + definition.Name);
            var scale = Math.Min((float)GlyphSize / sourceBounds.Width, (float)GlyphSize / sourceBounds.Height);
            var width = sourceBounds.Width * scale;
            var height = sourceBounds.Height * scale;
            var destinationBounds = new RectangleF((OutputSize - width) / 2f, (OutputSize - height) / 2f, width, height);
            if (Math.Abs(definition.RotationDegrees) > float.Epsilon)
            {
                graphics.TranslateTransform(OutputSize / 2f, OutputSize / 2f);
                graphics.RotateTransform(definition.RotationDegrees);
                graphics.TranslateTransform(-OutputSize / 2f, -OutputSize / 2f);
            }
            graphics.DrawImage(foreground, destinationBounds, sourceBounds, GraphicsUnit.Pixel);
            output.Save(target, ImageFormat.Png);
        }
    }

    // The camera keeps its approved, friendly silhouette but adopts the
    // classic two-tone rangefinder treatment: silver upper deck, black body,
    // no lettering or brand marks.
    private static void MakeTwoToneCamera(Bitmap image)
    {
        var bounds = ContentBounds(image);
        var silverDeckBottom = bounds.Top + (int)Math.Round(bounds.Height * .42f);
        for (var y = 0; y < image.Height; y++) for (var x = 0; x < image.Width; x++)
        {
            var pixel = image.GetPixel(x, y);
            if (pixel.A == 0) continue;
            var luminance = (pixel.R * 299 + pixel.G * 587 + pixel.B * 114) / 1000;
            if (y < silverDeckBottom && luminance >= 56)
            {
                var silver = Math.Min(226, 171 + luminance / 3);
                image.SetPixel(x, y, Color.FromArgb(pixel.A, silver, silver, silver - 2));
            }
            else if (luminance >= 175)
            {
                image.SetPixel(x, y, Color.FromArgb(pixel.A, 250, 247, 238));
            }
            else
            {
                image.SetPixel(x, y, Color.FromArgb(pixel.A, 29, 26, 24));
            }
        }
    }

    private static Bitmap RemoveConnectedArtboard(Bitmap input)
    {
        var width = input.Width;
        var height = input.Height;
        var transparent = new bool[width, height];
        var queue = new Queue<Point>();
        for (var x = 0; x < width; x++) { queue.Enqueue(new Point(x, 0)); queue.Enqueue(new Point(x, height - 1)); }
        for (var y = 1; y < height - 1; y++) { queue.Enqueue(new Point(0, y)); queue.Enqueue(new Point(width - 1, y)); }
        while (queue.Count > 0)
        {
            var point = queue.Dequeue();
            if (point.X < 0 || point.X >= width || point.Y < 0 || point.Y >= height || transparent[point.X, point.Y]) continue;
            if (!IsArtboard(input.GetPixel(point.X, point.Y))) continue;
            transparent[point.X, point.Y] = true;
            queue.Enqueue(new Point(point.X - 1, point.Y)); queue.Enqueue(new Point(point.X + 1, point.Y));
            queue.Enqueue(new Point(point.X, point.Y - 1)); queue.Enqueue(new Point(point.X, point.Y + 1));
        }
        var result = new Bitmap(width, height, PixelFormat.Format32bppArgb);
        for (var y = 0; y < height; y++) for (var x = 0; x < width; x++)
        {
            var pixel = input.GetPixel(x, y);
            result.SetPixel(x, y, transparent[x, y] ? Color.Transparent : pixel);
        }
        return result;
    }

    // The generated artboard has a faint neutral anti-aliased halo around each
    // glyph.  Cream/white parts inside the icons are protected by the
    // continuous dark outline because only background connected to a crop edge
    // is removed; the broader threshold therefore cleans the alpha without
    // touching the white eraser or the clear-paper fill.
    private static bool IsArtboard(Color color)
    {
        var max = Math.Max(color.R, Math.Max(color.G, color.B));
        var min = Math.Min(color.R, Math.Min(color.G, color.B));
        return min >= 140 && max - min <= 90;
    }

    private static Rectangle ContentBounds(Bitmap image)
    {
        var left = image.Width; var top = image.Height; var right = -1; var bottom = -1;
        for (var y = 0; y < image.Height; y++) for (var x = 0; x < image.Width; x++)
        {
            if (image.GetPixel(x, y).A == 0) continue;
            left = Math.Min(left, x); top = Math.Min(top, y); right = Math.Max(right, x); bottom = Math.Max(bottom, y);
        }
        return right < left || bottom < top ? Rectangle.Empty : Rectangle.FromLTRB(left, top, right + 1, bottom + 1);
    }
}

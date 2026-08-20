using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

// Raster source for Mark's optional Node-inspired flat toolbar skin.
// The delivered assets are PNG bitmaps; no SVG is used at runtime.
internal static class GenerateFlatIcons
{
    const int S = 96;
    static readonly Color Ink = Color.FromArgb(255, 91, 67, 49);      // #5b4331
    static readonly Color InkSoft = Color.FromArgb(255, 124, 96, 72);
    static readonly Color Paper = Color.FromArgb(255, 250, 240, 218);
    static readonly Color Purple = Color.FromArgb(255, 128, 88, 176);
    static readonly Color Green = Color.FromArgb(255, 91, 143, 79);
    static readonly Color Yellow = Color.FromArgb(255, 237, 184, 51);
    static readonly Color Kraft = Color.FromArgb(255, 220, 190, 139);

    static void Main(string[] args)
    {
        var output = args.Length > 0 ? args[0] : Path.Combine("assets", "icons", "flat");
        Directory.CreateDirectory(output);
        Save(output, "carrot-flat.png", Carrot);
        Save(output, "pencil-flat.png", Pencil);
        Save(output, "highlighter-flat.png", Highlighter);
        Save(output, "eraser-flat.png", Eraser);
        Save(output, "clear-flat.png", Clear);
        Save(output, "camera-flat.png", Camera);
        Save(output, "palette-flat.png", Palette);
        Save(output, "gear-flat.png", Gear);
    }

    static void Save(string output, string name, Action<Graphics> paint)
    {
        using (var image = new Bitmap(S, S, PixelFormat.Format32bppArgb))
        using (var graphics = Graphics.FromImage(image))
        {
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
            graphics.CompositingQuality = CompositingQuality.HighQuality;
            graphics.Clear(Color.Transparent);
            paint(graphics);
            image.Save(Path.Combine(output, name), ImageFormat.Png);
        }
    }

    static Pen Pen(Color color, float width = 5f) { return new Pen(color, width) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round }; }
    static Brush Brush(Color color) { return new SolidBrush(color); }
    static void Polygon(Graphics g, Brush brush, Pen pen, params PointF[] points) { g.FillPolygon(brush, points); g.DrawPolygon(pen, points); }

    static void Carrot(Graphics g)
    {
        using (var purple = Brush(Purple)) using (var white = Brush(Color.FromArgb(255, 247, 235, 208))) using (var green = Brush(Green)) using (var pen = Pen(Ink, 4.5f))
        {
            g.FillEllipse(purple, 22, 36, 53, 36);
            g.DrawEllipse(pen, 22, 36, 53, 36);
            g.FillPie(white, 22, 36, 53, 36, 0, 180);
            g.DrawLine(pen, 27, 53, 70, 53);
            Polygon(g, green, pen, new PointF(42, 37), new PointF(29, 15), new PointF(43, 23));
            Polygon(g, green, pen, new PointF(49, 36), new PointF(49, 10), new PointF(59, 25));
            Polygon(g, green, pen, new PointF(56, 38), new PointF(69, 17), new PointF(68, 33));
            g.DrawLine(pen, 48, 72, 48, 81);
        }
    }

    static void Pencil(Graphics g)
    {
        g.TranslateTransform(48, 48); g.RotateTransform(-45); g.TranslateTransform(-48, -48);
        using (var green = Brush(Green)) using (var wood = Brush(Color.FromArgb(255, 229, 189, 132))) using (var graphite = Brush(Ink)) using (var red = Brush(Color.FromArgb(255, 213, 88, 75))) using (var pen = Pen(Ink, 4.5f))
        {
            g.FillRectangle(green, 40, 16, 17, 48); g.DrawRectangle(pen, 40, 16, 17, 48);
            g.FillRectangle(red, 40, 12, 17, 8); g.DrawRectangle(pen, 40, 12, 17, 8);
            Polygon(g, wood, pen, new PointF(40, 64), new PointF(57, 64), new PointF(48.5f, 82));
            g.FillPolygon(graphite, new[] { new PointF(45, 74), new PointF(52, 74), new PointF(48.5f, 82) });
        }
        g.ResetTransform();
    }

    static void Highlighter(Graphics g)
    {
        g.TranslateTransform(48, 48); g.RotateTransform(-36); g.TranslateTransform(-48, -48);
        using (var yellow = Brush(Yellow)) using (var dark = Brush(Ink)) using (var cap = Brush(Color.FromArgb(255, 89, 89, 78))) using (var pen = Pen(Ink, 4.5f))
        {
            g.FillRoundedRectangle(yellow, 33, 15, 29, 50, 8); g.DrawRoundedRectangle(pen, 33, 15, 29, 50, 8);
            g.FillRoundedRectangle(cap, 33, 12, 29, 11, 6); g.DrawRoundedRectangle(pen, 33, 12, 29, 11, 6);
            g.FillRectangle(dark, 37, 65, 21, 10); g.DrawRectangle(pen, 37, 65, 21, 10);
            g.FillRectangle(yellow, 40, 75, 15, 9); g.DrawRectangle(pen, 40, 75, 15, 9);
        }
        g.ResetTransform();
    }

    static void Eraser(Graphics g)
    {
        g.TranslateTransform(48, 48); g.RotateTransform(-42); g.TranslateTransform(-48, -48);
        using (var paper = Brush(Color.FromArgb(255, 247, 245, 238))) using (var band = Brush(Color.FromArgb(255, 181, 204, 218))) using (var pen = Pen(Ink, 4.5f))
        {
            g.FillRoundedRectangle(paper, 31, 22, 34, 48, 8); g.DrawRoundedRectangle(pen, 31, 22, 34, 48, 8);
            g.FillRectangle(band, 31, 37, 34, 18); g.DrawRectangle(pen, 31, 37, 34, 18);
        }
        g.ResetTransform();
    }

    static void Clear(Graphics g)
    {
        using (var kraft = Brush(Kraft)) using (var pen = Pen(Ink, 5f))
        {
            g.FillRoundedRectangle(kraft, 20, 16, 55, 61, 8); g.DrawRoundedRectangle(pen, 20, 16, 55, 61, 8);
            g.DrawLine(pen, 60, 16, 75, 31); g.DrawLine(pen, 60, 16, 60, 31); g.DrawLine(pen, 60, 31, 75, 31);
            g.DrawArc(pen, 30, 31, 34, 30, 210, 215);
            Polygon(g, Brush(Ink), pen, new PointF(28, 50), new PointF(40, 42), new PointF(41, 57));
        }
    }

    static void Camera(Graphics g)
    {
        using (var paper = Brush(Color.FromArgb(255, 235, 222, 198))) using (var dark = Brush(Color.FromArgb(255, 88, 76, 64))) using (var purple = Brush(Purple)) using (var pen = Pen(Ink, 4.5f))
        {
            g.FillRoundedRectangle(dark, 17, 32, 62, 41, 9); g.DrawRoundedRectangle(pen, 17, 32, 62, 41, 9);
            g.FillRoundedRectangle(paper, 17, 24, 62, 22, 7); g.DrawRoundedRectangle(pen, 17, 24, 62, 22, 7);
            g.FillRectangle(dark, 28, 18, 19, 9); g.DrawRectangle(pen, 28, 18, 19, 9);
            g.FillEllipse(Brush(Color.FromArgb(255, 241, 236, 220)), 31, 36, 34, 34); g.DrawEllipse(pen, 31, 36, 34, 34);
            g.FillEllipse(purple, 40, 45, 16, 16); g.DrawEllipse(pen, 40, 45, 16, 16);
            g.FillEllipse(Brush(Color.FromArgb(255, 224, 195, 111)), 65, 29, 7, 7);
        }
    }

    static void Palette(Graphics g)
    {
        using (var paper = Brush(Color.FromArgb(255, 235, 203, 151))) using (var pen = Pen(Ink, 4.5f))
        {
            g.FillEllipse(paper, 15, 16, 66, 64); g.DrawEllipse(pen, 15, 16, 66, 64);
            g.FillEllipse(Brush(Color.Transparent), 24, 48, 15, 15); g.DrawEllipse(pen, 24, 48, 15, 15);
            Dot(g, 45, 27, Color.FromArgb(255, 230, 81, 65)); Dot(g, 62, 37, Color.FromArgb(255, 240, 186, 42));
            Dot(g, 62, 57, Green); Dot(g, 46, 68, Purple); Dot(g, 40, 47, Color.FromArgb(255, 67, 151, 214));
        }
    }
    static void Dot(Graphics g, float x, float y, Color color)
    {
        using (var fill = Brush(color)) using (var pen = Pen(Ink, 3.6f)) { g.FillEllipse(fill, x - 6, y - 6, 12, 12); g.DrawEllipse(pen, x - 6, y - 6, 12, 12); }
    }

    static void Gear(Graphics g)
    {
        using (var fill = Brush(Color.FromArgb(255, 116, 89, 68))) using (var inner = Brush(Color.FromArgb(255, 242, 226, 194))) using (var pen = Pen(Ink, 4.5f))
        {
            var points = new PointF[24];
            for (var i = 0; i < points.Length; i++)
            {
                var angle = -Math.PI / 2 + i * Math.PI * 2 / points.Length;
                var radius = i % 2 == 0 ? 36f : 27f;
                points[i] = new PointF(48 + radius * (float)Math.Cos(angle), 48 + radius * (float)Math.Sin(angle));
            }
            Polygon(g, fill, pen, points);
            g.FillEllipse(inner, 35, 35, 26, 26); g.DrawEllipse(pen, 35, 35, 26, 26);
            g.FillEllipse(Brush(InkSoft), 43, 43, 10, 10); g.DrawEllipse(pen, 43, 43, 10, 10);
        }
    }

    static GraphicsPath Rounded(float x, float y, float width, float height, float radius)
    {
        var path = new GraphicsPath();
        var diameter = radius * 2;
        path.AddArc(x, y, diameter, diameter, 180, 90); path.AddArc(x + width - diameter, y, diameter, diameter, 270, 90);
        path.AddArc(x + width - diameter, y + height - diameter, diameter, diameter, 0, 90); path.AddArc(x, y + height - diameter, diameter, diameter, 90, 90); path.CloseFigure();
        return path;
    }
    static void FillRoundedRectangle(this Graphics g, Brush brush, float x, float y, float width, float height, float radius) { using (var path = Rounded(x, y, width, height, radius)) g.FillPath(brush, path); }
    static void DrawRoundedRectangle(this Graphics g, Pen pen, float x, float y, float width, float height, float radius) { using (var path = Rounded(x, y, width, height, radius)) g.DrawPath(pen, path); }
}

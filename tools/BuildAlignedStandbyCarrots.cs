using System;
using System.Drawing;
using System.Drawing.Imaging;

// Standby and live marks should feel like one object changing state, not two
// separate illustrations.  Keep the original purple bulbs, but use the exact
// leaf/stem pixels from their matching heart assets.
internal static class BuildAlignedStandbyCarrots
{
    private static bool IsLeafColour(Color pixel)
    {
        if (pixel.A <= 4) return false;
        var hue = pixel.GetHue();
        return pixel.GetSaturation() >= .14f && hue >= 42f && hue <= 172f;
    }

    private static bool IsRedHeartColour(Color pixel)
    {
        if (pixel.A <= 4) return false;
        var hue = pixel.GetHue();
        return pixel.GetSaturation() >= .24f && (hue <= 28f || hue >= 338f);
    }

    private static bool HasLeafNeighbour(Bitmap image, int x, int y, int radius)
    {
        for (var oy = -radius; oy <= radius; oy++)
        for (var ox = -radius; ox <= radius; ox++)
        {
            var nx = x + ox; var ny = y + oy;
            if (nx < 0 || ny < 0 || nx >= image.Width || ny >= image.Height) continue;
            if (IsLeafColour(image.GetPixel(nx, ny))) return true;
        }
        return false;
    }

    private static void BuildMaterial(string bulbPath, string heartPath, string outputPath)
    {
        using (var bulb = new Bitmap(bulbPath))
        using (var heart = new Bitmap(heartPath))
        using (var output = new Bitmap(bulb.Width, bulb.Height, PixelFormat.Format32bppArgb))
        {
            for (var y = 0; y < bulb.Height; y++)
            for (var x = 0; x < bulb.Width; x++)
            {
                // Below this line the original contains only bulb/root detail;
                // it supplies the stable purple state without its old leaf set.
                var source = bulb.GetPixel(x, y);
                if (y >= 120 && source.A > 4 && !IsLeafColour(source)) output.SetPixel(x, y, source);

                // Material foliage has no graphic contour: copy only the true
                // green/yellow leaf and stem pixels from the red-heart icon.
                var leaf = heart.GetPixel(x, y);
                if (IsLeafColour(leaf)) output.SetPixel(x, y, leaf);
            }
            output.Save(outputPath, ImageFormat.Png);
        }
    }

    private static void BuildFlat(string bulbPath, string heartPath, string outputPath)
    {
        using (var bulb = new Bitmap(bulbPath))
        using (var heart = new Bitmap(heartPath))
        using (var output = new Bitmap(bulb.Width, bulb.Height, PixelFormat.Format32bppArgb))
        {
            for (var y = 0; y < bulb.Height; y++)
            for (var x = 0; x < bulb.Width; x++)
            {
                var source = bulb.GetPixel(x, y);
                // Preserve only the purple bulb/root base; green and its dark
                // outline are replaced by the live icon's exact leaf cluster.
                if (y >= 108 && source.A > 4 && !HasLeafNeighbour(bulb, x, y, 3)) output.SetPixel(x, y, source);

                var live = heart.GetPixel(x, y);
                // A two-pixel halo carries the characteristic brown cartoon
                // contour along with every green leaf/stem, never heart red.
                if (HasLeafNeighbour(heart, x, y, 2) && !IsRedHeartColour(live)) output.SetPixel(x, y, live);
            }
            output.Save(outputPath, ImageFormat.Png);
        }
    }

    public static void Main(string[] args)
    {
        if (args.Length != 4) throw new ArgumentException("Expected material bulb/heart and flat bulb/heart paths.");
        BuildMaterial(args[0], args[1], args[0].Replace("carrot-purple.png", "carrot-purple-aligned.png"));
        BuildFlat(args[2], args[3], args[2].Replace("carrot-flat.png", "carrot-flat-aligned.png"));
    }
}

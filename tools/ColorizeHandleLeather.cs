using System;
using System.Drawing;
using System.Drawing.Imaging;

// Derive a low-saturation crazy-horse leather family from the approved source
// grains.  The cap and the leather half of the paper seam share one target
// tone, while their original grain, seam and paper stay intact.
internal static class ColorizeHandleLeather {
    private static double Luminance(Color c) {
        return c.R * .2126 + c.G * .7152 + c.B * .0722;
    }
    private static byte Byte(double value) {
        return (byte)Math.Max(0, Math.Min(255, Math.Round(value)));
    }

    private static double AverageLuminance(Bitmap source, int lastRow) {
        var sum = 0d; var count = 0d;
        for (var y = 0; y < lastRow; y += 2)
            for (var x = 0; x < source.Width; x += 2) {
                sum += Luminance(source.GetPixel(x, y)); count++;
            }
        return sum / Math.Max(1d, count);
    }

    private static void RecolorLeather(Bitmap source, Bitmap output, int leatherRows, Color target) {
        var sourceMean = AverageLuminance(source, leatherRows);
        for (var y = 0; y < source.Height; y++) {
            for (var x = 0; x < source.Width; x++) {
                var pixel = source.GetPixel(x, y);
                if (y >= leatherRows) { output.SetPixel(x, y, pixel); continue; }
                // Keep the source scale, but compress contrast in the bitmap
                // itself.  This leaves a quiet, readable leather grain at
                // rack size instead of hiding it behind a flat colour veil.
                var gain = Math.Pow(Math.Max(.01, Luminance(pixel) / sourceMean), .34);
                output.SetPixel(x, y, Color.FromArgb(pixel.A, Byte(target.R * gain), Byte(target.G * gain), Byte(target.B * gain)));
            }
        }
    }

    public static int Main(string[] args) {
        if (args.Length != 4) { Console.Error.WriteLine("Usage: ColorizeHandleLeather <walnut.png> <seam.png> <handle-output.png> <seam-output.png>"); return 2; }
        using (var source = new Bitmap(args[0]))
        using (var seam = new Bitmap(args[1]))
        using (var handleOutput = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppArgb))
        using (var seamOutput = new Bitmap(seam.Width, seam.Height, PixelFormat.Format32bppArgb)) {
            // Match the established flat-handle brown (#71462f), then retain
            // the source leather's real luminance detail rather than painting
            // a synthetic CSS grain over it.
            var target = Color.FromArgb(113, 70, 47);
            RecolorLeather(source, handleOutput, source.Height, target);
            RecolorLeather(seam, seamOutput, seam.Height / 2, target);
            handleOutput.Save(args[2], ImageFormat.Png);
            seamOutput.Save(args[3], ImageFormat.Png);
            Console.WriteLine("Crazy-horse leather RGB: " + target.R + "," + target.G + "," + target.B);
        }
        return 0;
    }
}

import sys
from PIL import Image, ImageDraw

def process(img_path, out_path):
    # Open image, verify RGBA for transparency support
    img = Image.open(img_path).convert("RGBA")
    w, h = img.size
    
    # Create an empty greyscale mask
    mask = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(mask)
    
    # Increase macOS exact squircle radius visually to 26% for a smoother Pillow approximation
    r = int(w * 0.26)
    
    # Paint solid white on the mask in the rounded shape
    draw.rounded_rectangle((0, 0, w, h), radius=r, fill=255)
    
    # Apply alpha map to the base image and output
    img.putalpha(mask)
    img.save(out_path, "PNG")

if __name__ == "__main__":
    process(sys.argv[1], sys.argv[2])

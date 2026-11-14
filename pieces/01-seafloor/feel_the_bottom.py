# When does a swell start to feel the sea floor?
# Run it from this folder with:   python feel_the_bottom.py

# A variable is a name for a value. This one holds the swell period in seconds.
period = 6.6

# Deep-water wavelength in metres: 1.56 x period x period.
# The * sign means "times".
wavelength = 1.56 * period * period

# The wave feels the bottom when the water is shallower than half a wavelength.
# The / sign means "divided by".
feel_depth = wavelength / 2

# The deepest water in our Klitmoller data box (about 10 km offshore) is 34 m.
deepest_in_box = 34

how_many_times_deeper = feel_depth / deepest_in_box

# print() shows values on screen. The f"..." form drops variables into text:
# whatever is inside { } is replaced by its value. :.0f means "no decimals".
print(f"Period:           {period} s")
print(f"Wavelength:       {wavelength:.0f} m")
print(f"Feels bottom at:  {feel_depth:.0f} m depth")
print(f"Deepest in box:   {deepest_in_box:.0f} m depth")
print(f"Times deeper:     {how_many_times_deeper:.2f}")

# YOUR TASK
# 1. Change period to 10 and run it again. Does it match your hand calculation?
# 2. Add one new variable and one new print line that answer this:
#    how many times deeper is feel_depth than deepest_in_box?
# 3. Try periods 4, 6 and 12. For which of them is the swell already feeling
#    the bottom everywhere in our box?

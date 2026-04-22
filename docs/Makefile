SRC := user-manual.md
OUT := user-manual.pdf

PANDOC_FLAGS := \
	--pdf-engine=xelatex \
	--highlight-style=tango \
	-V mainfont="DejaVu Sans" \
	-V monofont="DejaVu Sans Mono" \
	-V links-as-notes=false

$(OUT): $(SRC)
	pandoc $(PANDOC_FLAGS) -o $@ $<

.PHONY: all clean
all: $(OUT)
clean:
	rm -f $(OUT)

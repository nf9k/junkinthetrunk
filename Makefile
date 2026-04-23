VERSION  := v1.00
DECODER  := jitt-trunk-recorder
API      := jitt-api
FRONTEND := jitt-frontend

.PHONY: build tag release

build:
	docker compose build

tag:
	docker tag $(DECODER):local  $(DECODER):$(VERSION)
	docker tag $(DECODER):local  $(DECODER):latest
	docker tag $(API):local      $(API):$(VERSION)
	docker tag $(API):local      $(API):latest
	docker tag $(FRONTEND):local $(FRONTEND):$(VERSION)
	docker tag $(FRONTEND):local $(FRONTEND):latest
	@echo "Tagged $(VERSION) and latest"

release: build tag

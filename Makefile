VERSION  := v1.00
DECODER  := jitr-trunk-recorder
API      := jitr-api
FRONTEND := jitr-frontend

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

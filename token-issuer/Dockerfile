FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
RUN go build -o /out/tirtc-issuer-cli ./cmd/tirtc-issuer-cli

FROM alpine:3.20
COPY --from=build /out/tirtc-issuer-cli /usr/local/bin/tirtc-issuer-cli
EXPOSE 8966
ENTRYPOINT ["tirtc-issuer-cli"]
CMD ["serve"]

# The relay has no dependencies: the image is node + two files, run as an unprivileged user with a read-only rootfs.
FROM node:22-alpine
WORKDIR /relay
COPY src/relay.mjs src/main.mjs ./
USER node
ENV PORT=8090 TRUST_PROXY=1
EXPOSE 8090
CMD ["node", "main.mjs"]

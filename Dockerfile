# Meal Plan: a family meal planner served to phones on the house network.
#
# Zero npm dependencies, like the rest of this stack -- everything is Node
# stdlib, so the image builds without reaching a registry for a dependency tree
# and there is nothing to audit.
FROM node:22-alpine

RUN apk add --no-cache tini

WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public

ENV NODE_ENV=production \
    PORT=8080 \
    MEALPLAN_DATA=/data

# The meal library and the plan. A named volume is mounted here by compose, so
# rebuilding the image never touches what the family has typed in.
VOLUME ["/data"]

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini, so a container stop is a signal the process actually receives rather
# than a ten-second wait followed by a kill.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]

ARG MODE=mysql
FROM alpine:latest AS build-base

RUN apk --quiet --no-cache add \
  git \
  build-base \
  clang \
  cmake \
  make \
  zlib-dev \
  curl-dev \
  lua-dev \
  patch \
  && rm -rf /var/cache/apk/*

ARG REPO=https://github.com/pvpgn/pvpgn-server.git
ARG BRANCH=master
RUN git clone --depth 1 --single-branch --branch ${BRANCH} ${REPO} /src

# Patch output.cpp so server.dat game lines include status + player count
#   from: gameN=CLIENTTAG,id,name
#   to:   gameN=CLIENTTAG,id,name,status,count
RUN cd /src \
 && sed -i 's|game%d=%s,%u,%s\\n|game%d=%s,%u,%s,%s,%u\\n|' src/bnetd/output.cpp \
 && sed -i 's|game_get_id(game), game_get_name(game));|game_get_id(game), game_get_name(game), game_status_get_str(game_get_status(game)), game_get_count(game));|' src/bnetd/output.cpp \
 && awk '{ if ($0 ~ /if \(p_mysql_real_connect\(mysql, host/) { print "    my_bool verify = 0;"; print "    mysql_options(mysql, MYSQL_OPT_SSL_VERIFY_SERVER_CERT, &verify);" } print }' src/bnetd/sql_mysql.cpp > /tmp/sql_mysql.cpp \
 && mv /tmp/sql_mysql.cpp src/bnetd/sql_mysql.cpp

COPY realm_presence_status.patch /realm_presence_status.patch
RUN cd /src && patch -p1 < /realm_presence_status.patch

RUN mkdir /src/build /usr/local/pvpgn
WORKDIR /src

################################################################################
FROM build-base AS build-mysql

RUN apk --quiet --no-cache add \
  mariadb-dev \
  && rm -rf /var/cache/apk/*

ENV WITH_LUA=true
ENV WITH_MYSQL=true
ENV WITH_SQLITE3=false
ENV WITH_PGSQL=false
ENV WITH_ODBC=false

RUN cmake -G "Unix Makefiles" -H./ -B./build \
  -D WITH_LUA=${WITH_LUA} \
  -D WITH_MYSQL=${WITH_MYSQL} \
  -D WITH_SQLITE3=${WITH_SQLITE3} \
  -D WITH_PGSQL=${WITH_PGSQL} \
  -D WITH_ODBC=${WITH_ODBC} \
  -D CMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -D CMAKE_INSTALL_PREFIX=/ \
  && cd build && make -j$(nproc)

################################################################################
FROM build-mysql AS build

WORKDIR /src/build
RUN make install && chown -R 1001:1001 /var/pvpgn /etc/pvpgn

################################################################################
FROM alpine:latest AS runner-mysql

RUN apk --quiet --no-cache add \
  ca-certificates \
  libstdc++ \
  libgcc \
  libcurl \
  lua5.1-libs \
  mariadb-connector-c \
  su-exec \
  && rm -rf /var/cache/apk/*

COPY --from=build \
  /sbin/bnetd \
  /sbin/bntrackd \
  /sbin/d2cs \
  /sbin/d2dbs \
  /sbin/
COPY --from=build \
  /bin/bn* \
  /bin/sha1hash \
  /bin/tgainfo \
  /bin/
COPY --from=build --chown=1001:1001 /etc/pvpgn /etc/pvpgn
COPY --from=build --chown=1001:1001 /var/pvpgn /var/pvpgn

RUN addgroup --gid 1001 pvpgn \
  && adduser \
  --home /var/pvpgn \
  --gecos "" \
  --shell /sbin/nologin \
  --ingroup pvpgn \
  --system \
  --disabled-password \
  --no-create-home \
  --uid 1001 \
  pvpgn

VOLUME /var/pvpgn
VOLUME /etc/pvpgn

EXPOSE 6112 4000

COPY pvpgn-entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["bnetd", "-f"]

FROM openjdk:18-slim

WORKDIR /opt/Lavalink

# Download Lavalink
RUN apt-get update && apt-get install -y curl && \
    curl -L https://github.com/lavalink-devs/Lavalink/releases/download/4.2.2/Lavalink.jar -o Lavalink.jar

# Create plugins directory
RUN mkdir -p plugins

# Download plugins
RUN curl -L https://github.com/lavalink-devs/LavaSrc/releases/download/4.0.0/LavaSrc-4.0.0.jar -o plugins/LavaSrc.jar && \
    curl -L https://github.com/lavalink-devs/youtube-source/releases/download/1.10.13/youtube-source-1.10.13.jar -o plugins/youtube.jar

# Copy config
COPY application.yml application.yml

EXPOSE 8080

CMD ["java", "-jar", "Lavalink.jar"]
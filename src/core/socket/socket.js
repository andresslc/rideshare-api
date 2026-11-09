const { Server } = require("socket.io");
const socketAuthMiddleware = require("../middlewares/protect-socket.middleware");

// Import sockets
const { getRedisConnection } = require("../services/redis/redis.service");
const driverSocket = require("../../feature/driver/driver.socket");
const carpoolSocket = require("../../feature/carpool/carpool-ride.socket");
const rideSocket = require("../../feature/ride/ride.socket");
const chatSocket = require("../../feature/chat/chat.socket");
const guestSocket = require("../../feature/ride/guest.socket");
const carpoolGuestSocket = require("../../feature/carpool/guest.socket");
const {
  USER,
  SOCKET,
  DRIVER,
  RIDE,
  ACTIVE,
  DRIVER_SOCKET_EVENTS,
} = require("../common/constants/ride-constants");
const { REDIS_CONSTANTS } = require("../common/constants/redis-constants");
const initRidePaymentListeners = require("../../feature/ride/ride.events");
const intiCarpoolPaymentListeners = require("../../feature/carpool/carpool.events");
const { formatFullName } = require("../common/helpers");
const {
  trackPassengerPresence,
  removePassengerPresence,
} = require("../../feature/ride/high-demand.service");

class SocketIOService {
  constructor(server) {
    this.io = new Server(server, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"],
      },
      transports: ["websocket"],
    });

    this.redis = getRedisConnection();
  }

  initialize() {
    this.io.use(socketAuthMiddleware);
    this.io.use(initRidePaymentListeners(this.io));
    this.io.use(intiCarpoolPaymentListeners(this.io));

    this.io.on("connection", async (socket) => {
      const userId = socket?.user?._id?.toString();
      const role = socket?.user?.role || socket.metadata?.role;

      /*
        Increment per-user connection counter in Redis
      */
      if (userId) {
        await this.redis.incr(`socket:connections:${userId}`);
        const count = await this.redis.get(`socket:connections:${userId}`);
        console.log(
          `User Connected, Name: ${formatFullName(socket.user)}, User ID: ${userId}, total connections: ${count}, Role: ${role}`,
        );
      }

      /*
        Store user socket mapping
      */
      if (role === "user") {
        await this.redis.set(`${USER}:${userId}:${SOCKET}`, socket.id);
      } else if (role === "driver") {
        await this.redis.set(`${DRIVER}:${userId}:${SOCKET}`, socket.id);

        // Idle drivers still have to explicitly go online. An active driver,
        // however, must recover the live-map presence lost during a reconnect.
        const [activeRideId, activeCarpoolRideId] = await Promise.all([
          this.redis.get(`${DRIVER}:${userId}:${RIDE}:${ACTIVE}`),
          this.redis.get(REDIS_CONSTANTS.keys.driverCarpoolActive(userId)),
        ]);

        if (activeRideId || activeCarpoolRideId) {
          await this.redis.hset(`${DRIVER}:${userId}`, {
            socket: socket.id,
            status: DRIVER_SOCKET_EVENTS.ONLINE_STATUS,
            vehicleType: socket.user.vehicleType,
          });
        }
      }

      /*
        Mount Sockets
      */
      if (role === "guest") {
        if (socket.metadata?.carpoolId) {
          carpoolGuestSocket(this.io, socket);
        } else {
          guestSocket(this.io, socket);
        }
        return;
      }

      if (role === "driver") {
        driverSocket(this.io, socket);
      }

      if (["user", "driver"].includes(role)) {
        rideSocket(this.io, socket);
        carpoolSocket(this.io, socket);
        chatSocket(this.io, socket);
      }

      /*
        Handle disconnect
      */
      socket.on("disconnect", async () => {
        console.log("User disconnected:", userId, "Socket ID:", socket.id);

        if (role === "user") {
          const socketKey = `${USER}:${userId}:${SOCKET}`;
          if ((await this.redis.get(socketKey)) === socket.id) {
            await this.redis.del(socketKey);
            await removePassengerPresence(userId);
          }
        } else if (role === "driver") {
          const socketKey = `${DRIVER}:${userId}:${SOCKET}`;
          if ((await this.redis.get(socketKey)) === socket.id) {
            await this.redis.del(socketKey);
          }
        }

        // Decrement per-user connection counter in Redis
        if (userId) {
          await this.redis.decr(`socket:connections:${userId}`);
          const count = await this.redis.get(`socket:connections:${userId}`);
          console.log(
            `User Disconnected, Name: ${formatFullName(socket.user)}, User ID: ${userId}, total connections: ${count}, Role: ${role}`,
          );
        }
      });
    });
  }
}

module.exports = SocketIOService;

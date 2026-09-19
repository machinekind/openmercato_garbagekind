# syntax=docker/dockerfile:1
ARG BASE_IMAGE=osrf/ros:humble-desktop-full
FROM ${BASE_IMAGE}

ARG USERNAME=ros
ARG USER_UID=1000
ARG USER_GID=1000

ENV DEBIAN_FRONTEND=noninteractive
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# --- Development tooling -----------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
        bash-completion \
        build-essential \
        can-utils \
        ccache \
        clang-format \
        cmake \
        curl \
        gdb \
        git \
        iproute2 \
        iputils-ping \
        less \
        lsb-release \
        nano \
        openssh-client \
        python3-argcomplete \
        python3-colcon-common-extensions \
        python3-colcon-mixin \
        python3-pip \
        python3-rosdep \
        python3-vcstool \
        ros-dev-tools \
        tmux \
        udev \
        usbutils \
        vim \
        wget \
    && rm -rf /var/lib/apt/lists/*

# --- Extra ROS 2 packages ----------------------------------------------------
# Add project-specific packages here; keep it in one layer for cache friendliness.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ros-humble-rmw-cyclonedds-cpp \
        ros-humble-rmw-fastrtps-cpp \
        ros-humble-rqt-common-plugins \
        ros-humble-rqt-graph \
        ros-humble-tf2-tools \
        ros-humble-xacro \
        ros-humble-joint-state-publisher-gui \
        ros-humble-rosbag2-storage-mcap \
        ros-humble-usb-cam \
        ros-humble-image-transport-plugins \
    && rm -rf /var/lib/apt/lists/*

# --- Non-root user matching the host UID/GID ---------------------------------
RUN if getent group ${USER_GID} >/dev/null; then \
        existing_group="$(getent group ${USER_GID} | cut -d: -f1)"; \
        groupmod -n ${USERNAME} "${existing_group}"; \
    else \
        groupadd --gid ${USER_GID} ${USERNAME}; \
    fi \
 && if getent passwd ${USER_UID} >/dev/null; then \
        existing_user="$(getent passwd ${USER_UID} | cut -d: -f1)"; \
        usermod -l ${USERNAME} -d /home/${USERNAME} -m "${existing_user}"; \
    else \
        useradd --uid ${USER_UID} --gid ${USER_GID} -m -s /bin/bash ${USERNAME}; \
    fi \
 && apt-get update && apt-get install -y --no-install-recommends sudo \
 && rm -rf /var/lib/apt/lists/* \
 && echo "${USERNAME} ALL=(root) NOPASSWD:ALL" > /etc/sudoers.d/${USERNAME} \
 && chmod 0440 /etc/sudoers.d/${USERNAME} \
 && for g in dialout video plugdev audio render; do \
        getent group "$g" >/dev/null && usermod -aG "$g" ${USERNAME} || true; \
    done

# --- Shell environment -------------------------------------------------------
# The ROS setup lives in one file sourced from three places, because each kind
# of shell reads a different one:
#   * /etc/profile.d  -> login shells, incl. `bash -lc` and `docker exec bash -l`
#   * ~/.bashrc       -> interactive shells (`docker compose exec ros2 bash`)
#   * entrypoint.sh   -> `docker run` / compose `command:`
# Ubuntu's stock .bashrc returns early when non-interactive, so it alone is not
# enough for `bash -lc "ros2 ..."`.
RUN mkdir -p /home/${USERNAME}/ros2_ws/src \
 && install -d -m 0700 -o ${USER_UID} -g ${USER_GID} /tmp/runtime-ros \
 && { \
      echo '# ROS 2 Humble environment (generated at image build time)'; \
      echo 'source /opt/ros/humble/setup.bash'; \
      echo 'if [ -f "$HOME/ros2_ws/install/setup.bash" ]; then source "$HOME/ros2_ws/install/setup.bash"; fi'; \
      echo 'export _colcon_cd_root="$HOME/ros2_ws"'; \
      echo 'export PATH=/usr/lib/ccache:$PATH'; \
      echo '[ -f /usr/share/colcon_cd/function/colcon_cd.sh ] && source /usr/share/colcon_cd/function/colcon_cd.sh'; \
      echo 'case $- in *i*)'; \
      echo '  [ -f /usr/share/colcon_argcomplete/hook/colcon-argcomplete.bash ] && source /usr/share/colcon_argcomplete/hook/colcon-argcomplete.bash'; \
      echo '  ;; esac'; \
      echo "alias cb='cd ~/ros2_ws && colcon build --symlink-install --cmake-args -DCMAKE_BUILD_TYPE=RelWithDebInfo'"; \
      echo "alias cbp='cd ~/ros2_ws && colcon build --symlink-install --packages-select'"; \
      echo "alias ct='cd ~/ros2_ws && colcon test && colcon test-result --verbose'"; \
      echo "alias sws='source ~/ros2_ws/install/setup.bash'"; \
    } > /etc/ros2_env.sh \
 && chmod 0644 /etc/ros2_env.sh \
 && echo '. /etc/ros2_env.sh' > /etc/profile.d/10-ros2.sh \
 && chmod 0644 /etc/profile.d/10-ros2.sh \
 && echo '. /etc/ros2_env.sh' >> /home/${USERNAME}/.bashrc \
 && chown -R ${USER_UID}:${USER_GID} /home/${USERNAME}

# rosdep is already initialized in the osrf images; update the cache for the user.
USER ${USERNAME}
RUN rosdep update --rosdistro humble || true

USER root
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER ${USERNAME}
WORKDIR /home/${USERNAME}/ros2_ws
ENV SHELL=/bin/bash
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bash"]

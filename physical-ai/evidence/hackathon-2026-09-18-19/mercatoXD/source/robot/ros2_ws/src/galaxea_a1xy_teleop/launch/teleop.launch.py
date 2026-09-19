"""Leader driver (can1, read-only) + arm-to-arm teleop.

The vendor HDAS stack for the follower on can0 is NOT started here: it needs the
SDK overlay on LD_LIBRARY_PATH and is launched separately. See teleop_a2a.sh at
the top of the repo, which brings up all three pieces in the right order.
"""
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare
from launch.substitutions import PathJoinSubstitution


def generate_launch_description():
    leader_can = LaunchConfiguration('leader_can')
    params = PathJoinSubstitution(
        [FindPackageShare('galaxea_a1xy_teleop'), 'config', 'teleop.yaml'])

    return LaunchDescription([
        DeclareLaunchArgument('leader_can', default_value='can1'),
        DeclareLaunchArgument('enable_gripper', default_value='false'),
        # Teach mode: energise the leader and stream it zero torque, so its
        # encoders report while it stays free in your hand. Without this an A1X
        # is either rigid or transmits a frozen payload, and neither can drive a
        # follower. The arm has NO BRAKES and sags the moment this takes effect.
        DeclareLaunchArgument('leader_teach', default_value='true'),

        Node(
            package='galaxea_a1xy_driver', executable='driver_node',
            namespace='leader', name='a1xy_driver', output='screen',
            parameters=[{'can_interface': leader_can,
                         'command_can_id': -1,
                         'heartbeat': False,
                         'backdrive': LaunchConfiguration('leader_teach')}],
        ),
        Node(
            package='galaxea_a1xy_teleop', executable='teleop_node',
            name='a1x_teleop', output='screen', emulate_tty=True,
            parameters=[params, {
                'enable_gripper': LaunchConfiguration('enable_gripper')}],
        ),
    ])

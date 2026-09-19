from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    return LaunchDescription([
        DeclareLaunchArgument('can_interface', default_value='can0'),
        DeclareLaunchArgument('command_can_id', default_value='-1',
                              description='-1 = read-only. Set only when known.'),
        Node(
            package='galaxea_a1xy_driver',
            executable='driver_node',
            name='a1xy_driver',
            output='screen',
            parameters=[{
                'can_interface': LaunchConfiguration('can_interface'),
                'command_can_id': LaunchConfiguration('command_can_id'),
            }],
        ),
    ])
